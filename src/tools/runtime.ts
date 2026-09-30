/**
 * Runtime inspection tools: the running game's scene tree and node properties, through the remote
 * debugger.
 */

import { DebugSession, InspectedObject, RemoteNode, RemoteProperty } from '../debug-session.js';
import { ProjectRunner } from '../godot-run.js';
import { SETTABLE_TYPES, inferVariantType, jsonToVariant, variantToJson } from '../runtime-values.js';
import { ToolContext, ToolDefinition, ToolError, jsonReply } from '../tool-requests.js';
import { VariantType } from '../variant.js';

// Property usage flags (Godot's PropertyUsageFlags) and the hint Godot sends for values too big to send
const PROPERTY_USAGE_STORAGE = 1 << 1;
const PROPERTY_USAGE_GROUPING = (1 << 6) | (1 << 7) | (1 << 8); // group, category, subgroup
const PROPERTY_USAGE_SCRIPT_VARIABLE = 1 << 12;
const PROPERTY_HINT_OBJECT_TOO_BIG = 25;
const RUNTIME_PATH_RULE =
  'An absolute path in the running game as get_scene_tree shows it, e.g. "/root/Main/Player" (the leading "/" is optional). ' +
  'The running tree starts at the window "root", with autoloads next to the main scene; this differs from the scene-file tools.';

export function runtimeTools(ctx: ToolContext): ToolDefinition[] {
  return [
    {
      name: 'get_scene_tree',
      description:
        'List the live scene tree of the game started by run_project, including autoloads and nodes created at runtime ' +
        '(needs the remote debugger, Godot 4.2+). Each node has its path, and its engine type or, for a scripted node, ' +
        'its script (a script with class_name shows as the type)',
      params: {
        path: { type: 'string', description: `Optional: list only this subtree. ${RUNTIME_PATH_RULE}` },
        maxNodes: { type: 'integer', description: 'Maximum number of nodes to list (default: 500)', minimum: 1, default: 500 },
      },
      required: [],
      failure: 'Failed to get the scene tree',
      handle: async (args) => {
        const session = requireSession(ctx.runner);
        let start = await session.sceneTree();
        if (args.path) start = await requireNode(session, runtimePath(args.path));

        const maxNodes: number = args.maxNodes;
        let listed = 0;
        let omitted = 0;
        const toJson = (node: RemoteNode): object | null => {
          if (listed >= maxNodes) {
            omitted += countNodes(node);
            return null;
          }
          listed++;
          const scripted = node.typeName.startsWith('res://');
          const children = node.children.map(toJson).filter((child) => child !== null);
          return {
            name: node.name,
            path: node.path,
            ...(scripted ? { script: node.typeName } : { type: node.typeName }),
            ...(node.sceneFile ? { scene: node.sceneFile } : {}),
            ...(children.length > 0 ? { children } : {}),
          };
        };
        const tree = toJson(start);
        const starting = !args.path && start.children.length === 0;
        return jsonReply({
          tree,
          ...(omitted > 0 ? { omittedNodes: omitted, note: `Only ${maxNodes} nodes are listed; pass path for a subtree or raise maxNodes` } : {}),
          ...(starting ? { note: 'The game has not added its autoloads and main scene yet; try again in a moment' } : {}),
        });
      },
    },
    {
      name: 'get_node_properties',
      description:
        "Read a node's state in the running game: its script variables and its stored engine properties, as JSON " +
        '(vectors as arrays, colors as {r,g,b,a}, resources as {resource}, node references as {node})',
      params: {
        nodePath: { type: 'string', description: RUNTIME_PATH_RULE },
        names: { type: 'array', items: { type: 'string' }, description: 'Optional: return only these script variables or properties' },
      },
      required: ['nodePath'],
      failure: 'Failed to read node properties',
      handle: async (args) => {
        const session = requireSession(ctx.runner);
        const path = runtimePath(args.nodePath);
        const { node, inspected } = await inspectNode(session, path);

        const script: Record<string, unknown> = {};
        const properties: Record<string, unknown> = {};
        let scriptPath: unknown = node.typeName.startsWith('res://') ? node.typeName : undefined;
        for (const property of inspected.properties) {
          if (property.name === 'script' && typeof property.value === 'string') scriptPath = property.value;
          const listed = listedProperty(property);
          if (!listed) continue;
          const value = property.hint === PROPERTY_HINT_OBJECT_TOO_BIG ? '<too big to send>' : variantToJson(property.value, session.nodePathOf, property.type);
          (listed.section === 'script' ? script : properties)[listed.name] = value;
        }

        let unknownNames: string[] = [];
        if (args.names) {
          const wanted = new Set<string>(args.names);
          unknownNames = [...wanted].filter((name) => !(name in script) && !(name in properties));
          for (const section of [script, properties]) {
            for (const name of Object.keys(section)) if (!wanted.has(name)) delete section[name];
          }
        }

        return jsonReply({
          node: { path, class: inspected.className, ...(scriptPath ? { script: scriptPath } : {}) },
          script,
          properties,
          ...(unknownNames.length > 0 ? { unknownNames } : {}),
        });
      },
    },
    {
      name: 'set_node_property',
      description:
        'Set a property or script variable of a node in the running game and return the value it now holds. ' +
        'Only the running game changes; scene files are not touched',
      params: {
        nodePath: { type: 'string', description: RUNTIME_PATH_RULE },
        property: { type: 'string', description: 'Property or script variable name, as get_node_properties lists it' },
        value: { type: 'any', description: `New value as JSON. Settable types: ${SETTABLE_TYPES}` },
      },
      required: ['nodePath', 'property', 'value'],
      failure: 'Failed to set the node property',
      handle: async (args) => {
        const session = requireSession(ctx.runner);
        const path = runtimePath(args.nodePath);
        const { node, inspected } = await inspectNode(session, path);

        const entry = inspected.properties.find((property) => listedProperty(property)?.name === args.property);
        if (!entry) {
          throw new ToolError(`${path} has no property or script variable named ${args.property}`, [
            'Use get_node_properties to list its script variables and properties',
          ]);
        }

        let value: unknown;
        try {
          // Script members arrive without a declared type
          const type = entry.type !== VariantType.NIL ? entry.type : inferVariantType(entry.value, args.value);
          value = jsonToVariant(type, args.value);
        } catch (error) {
          throw new ToolError(`Cannot set ${args.property}: ${error instanceof Error ? error.message : error}`);
        }
        session.setProperty(node.id, entry.name, value);

        // The game answers messages in order, so this reads the value after the change
        const after = await session.inspect(node.id);
        const updated = after?.properties.find((property) => property.name === entry.name);
        return jsonReply({
          node: path,
          property: args.property,
          value: updated ? variantToJson(updated.value, session.nodePathOf, updated.type) : null,
        });
      },
    },
  ];
}

/** Why runtime tools cannot use the debug session */
export function sessionUnavailable(reason: string): ToolError {
  return new ToolError(reason, [
    'Runtime tools need a game started by run_project with the remote debugger attached (Godot 4.2+)',
    'get_debug_output shows whether the debugger is attached',
  ]);
}

/**
 * The running game's debug session; throws why runtime tools cannot use it when it is missing or
 * the game has not connected yet
 */
export function requireSession(runner: ProjectRunner): DebugSession {
  const session = runner.debugSession();
  if (session?.isConnected) return session;
  throw sessionUnavailable(session ? 'The game has not connected to the debugger yet; try again in a moment' : runner.noSessionReason());
}

/** The node at an absolute path in the running game; throws if there is none */
async function requireNode(session: DebugSession, path: string): Promise<RemoteNode> {
  const node = await session.findNode(path);
  if (node) return node;
  throw new ToolError(`No node at ${path} in the running game`, [
    `Closest paths: ${session.nearestPaths(path).join(', ')}`,
    'Use get_scene_tree to list the nodes',
  ]);
}

/** The node at an absolute path and its properties; throws if the node does not exist */
async function inspectNode(session: DebugSession, path: string): Promise<{ node: RemoteNode; inspected: InspectedObject }> {
  const node = await requireNode(session, path);
  const inspected = await session.inspect(node.id);
  if (!inspected) throw new ToolError(`The node at ${path} no longer exists`, ['Use get_scene_tree to list the current nodes']);
  return { node, inspected };
}

// Runtime node paths are absolute; the leading "/" is optional for agents
function runtimePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function countNodes(node: RemoteNode): number {
  return 1 + node.children.reduce((total, child) => total + countNodes(child), 0);
}

/**
 * Where get_node_properties lists a property, and under which name; null for entries it leaves out:
 * editor categories and groups, script constants, the script itself, and the debugger's own
 * Node/path and Node/multiplayer_authority entries.
 */
function listedProperty(property: RemoteProperty): { section: 'script' | 'properties'; name: string } | null {
  const { name, usage } = property;
  if (usage & PROPERTY_USAGE_GROUPING || name === 'script' || name.startsWith('Constants/') || name.startsWith('Node/')) return null;
  // Members of the node's own script are "Members/<name>"; inherited ones "Members/<base.gd>/<name>"
  if (name.startsWith('Members/')) return { section: 'script', name: name.slice('Members/'.length) };
  if (usage & PROPERTY_USAGE_SCRIPT_VARIABLE) return { section: 'script', name };
  if (usage & PROPERTY_USAGE_STORAGE) return { section: 'properties', name };
  return null;
}
