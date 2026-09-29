/**
 * Tool definitions and request preparation: turns a tool's declaration into its input schema,
 * and checks each call's arguments against it before the tool runs.
 */

import { existsSync, statSync } from 'fs';
import { join } from 'path';

export type ToolArgs = Record<string, any>;

export interface ToolReply {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  // MCP results are open objects
  [key: string]: unknown;
}

/**
 * What request preparation verifies about a parameter before the tool runs.
 * - project: a directory containing project.godot
 * - directory: an existing directory
 * - projectFile: a path inside the project; must not contain '..'
 * - existingFile: a projectFile that must exist; may be given relative to the project or as res://
 * - className: a Godot class name, so agents cannot instantiate arbitrary scripts by path
 * Every check except className also rejects paths containing '..'.
 */
export type Check = 'project' | 'directory' | 'projectFile' | 'existingFile' | 'className';

export interface Param {
  /** 'any' lists no type in the schema, for parameters that take any JSON value */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';
  description: string;
  items?: { type: string };
  check?: Check;
  /** For existingFile: what the file is, used in the "does not exist" message. Defaults to "File". */
  label?: string;
  /** For existingFile: an extra suggestion when the file is missing. */
  hint?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Tool parameters in camelCase. snake_case spellings of the same names are accepted as aliases. */
  params: Record<string, Param>;
  required: string[];
  /** Prefix of every failure reply, e.g. "Failed to add node". */
  failure: string;
  /** Minimum Godot version, checked before the tool runs. */
  minGodot?: { version: [number, number]; feature: string; solutions: string[] };
  /** Runs a godot_operations.gd operation with every argument except projectPath. */
  operation?: {
    name: string;
    solutions: string[];
    render(result: any, args: ToolArgs): string;
  };
  /** Runs anything else. Exactly one of operation and handle is set. */
  handle?(args: ToolArgs): Promise<ToolReply>;
}

/**
 * A failure a tool reports to the agent. The reply is the message, then the possible solutions,
 * then `details` (e.g. Godot's output) when given.
 */
export class ToolError extends Error {
  constructor(message: string, readonly solutions: string[] = [], readonly details?: string) {
    super(message);
  }
}

export function errorReply(message: string, possibleSolutions: string[] = [], details?: string): ToolReply {
  console.error(`[SERVER] Error response: ${message}`);
  const reply: ToolReply = { content: [{ type: 'text', text: message }], isError: true };
  if (possibleSolutions.length > 0) {
    reply.content.push({ type: 'text', text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- ') });
  }
  if (details) {
    reply.content.push({ type: 'text', text: details });
  }
  return reply;
}

export function textReply(text: string): ToolReply {
  return { content: [{ type: 'text', text }] };
}

export function jsonReply(value: unknown): ToolReply {
  return textReply(JSON.stringify(value, null, 2));
}

/**
 * The JSON schema listed for a tool.
 */
export function inputSchema(tool: ToolDefinition) {
  const properties = Object.fromEntries(
    Object.entries(tool.params).map(([name, { type, items, description }]) => [
      name,
      type === 'any' ? { description } : items ? { type, items, description } : { type, description },
    ])
  );
  return { type: 'object' as const, properties, required: tool.required };
}

/**
 * Normalize and check the arguments of a tool call. Returns the declared arguments in camelCase,
 * or the error reply to send instead of running the tool.
 */
export async function prepareRequest(
  tool: ToolDefinition,
  rawArgs: ToolArgs,
  godotVersion: () => Promise<string>
): Promise<{ args: ToolArgs } | { error: ToolReply }> {
  // Only top-level names are converted; values such as add_node's properties pass through unchanged
  const args: ToolArgs = {};
  for (const name of Object.keys(tool.params)) {
    const value = rawArgs[name] ?? rawArgs[snakeCase(name)];
    if (value !== undefined && value !== null) {
      args[name] = value;
    }
  }

  // An empty string counts as missing for string parameters, not for parameters taking any JSON value
  const missing = tool.required.filter((name) => args[name] === undefined || (args[name] === '' && tool.params[name].type === 'string'));
  if (missing.length > 0) {
    return { error: errorReply(`Missing required parameters: ${missing.join(', ')}`, [`Provide ${tool.required.join(', ')}`]) };
  }

  const checked = Object.entries(tool.params).filter(([name, param]) => param.check && args[name] !== undefined);

  // Checks on the values themselves come before any filesystem access
  for (const [name, param] of checked) {
    const value = String(args[name]);
    if (param.check === 'className') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        return { error: errorReply(`Invalid ${name}: ${value}`, [`${name} must be a Godot class name or a global script class name (no paths, no file extensions)`]) };
      }
    } else if (value.includes('..')) {
      return { error: errorReply(`Invalid path in ${name}: ${value}`, ['Provide a path without ".." or other potentially unsafe characters']) };
    }
  }

  // The project is checked before files inside it
  for (const [name, param] of checked) {
    const value = String(args[name]);
    if (param.check === 'project' && !existsSync(join(value, 'project.godot'))) {
      return {
        error: errorReply(`Not a valid Godot project: ${value}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]),
      };
    }
    if (param.check === 'directory' && !(existsSync(value) && statSync(value).isDirectory())) {
      return { error: errorReply(`Directory does not exist: ${value}`, ['Provide a valid directory path that exists on the system']) };
    }
  }

  for (const [name, param] of checked.filter(([, param]) => param.check === 'existingFile')) {
    const value = String(args[name]);
    if (!existsSync(join(args.projectPath, value.replace(/^res:\/\//, '')))) {
      const label = param.label ?? 'File';
      const solutions = [`Ensure the ${label.toLowerCase()} path is correct and relative to the project`];
      if (param.hint) solutions.push(param.hint);
      return { error: errorReply(`${label} does not exist: ${value}`, solutions) };
    }
  }

  if (tool.minGodot) {
    const { version: [major, minor], feature, solutions } = tool.minGodot;
    const version = await godotVersion();
    if (!godotVersionAtLeast(version, [major, minor])) {
      return { error: errorReply(`${feature} are only supported in Godot ${major}.${minor} or later. Current version: ${version}`, solutions) };
    }
  }

  return { args };
}

/**
 * Whether a `godot --version` string such as "4.7.2.stable.official" is at least major.minor
 */
export function godotVersionAtLeast(version: string, [major, minor]: [number, number]): boolean {
  const match = version.match(/^(\d+)\.(\d+)/);
  return match !== null && (Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor));
}

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
