/**
 * Tool definitions and request preparation: turns a tool's declaration into its input schema,
 * and checks each call's arguments against it before the tool runs.
 */

import { existsSync, statSync } from 'fs';
import { join, win32 } from 'path';

import { Breakpoint } from './debug-session.js';
import { GodotLauncher } from './godot-launcher.js';
import { ProjectRunner } from './godot-run.js';

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
 * - projectFile: a path inside the project, relative to it or as res://; must not be absolute or contain '..'
 * - existingFile: a projectFile that must exist
 * - className: a Godot class name, so agents cannot instantiate arbitrary scripts by path
 * Every check except className also rejects paths containing '..'.
 */
export type Check = 'project' | 'directory' | 'projectFile' | 'existingFile' | 'className';

/**
 * A tool parameter. Request preparation checks the type, enum and bounds, and fills in the default;
 * all but `check`, `label` and `hint` are listed in the input schema as they are.
 */
export interface Param {
  /** 'any' lists no type in the schema, for parameters that take any JSON value */
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'any';
  description: string;
  items?: { type: 'string' };
  /** Value used when the argument is missing */
  default?: unknown;
  /** Allowed values of a string parameter */
  enum?: string[];
  /** Bounds of a number or integer parameter */
  minimum?: number;
  maximum?: number;
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
  /** Runs the tool with checked arguments. Throws ToolError to reply with a failure. */
  handle(args: ToolArgs): Promise<ToolReply>;
}

/**
 * What tools use of the server. Tools are built once Godot has been found.
 */
export interface ToolContext {
  godotPath: string;
  /** The version string `godot --version` reports */
  godotVersion(): Promise<string>;
  launcher: GodotLauncher;
  runner: ProjectRunner;
  /** Kept by the server, so they apply to every run */
  breakpoints: Map<string, Breakpoint>;
  /** Attach Godot's remote debugger to games started by run_project */
  remoteDebugger: boolean;
  /** Time limit for one Godot operation or import, in milliseconds */
  operationTimeoutMs: number;
  /** Attach Godot's output to failures and log debug messages */
  debugMode: boolean;
  log(message: string): void;
}

export const projectPathParam: Param = { type: 'string', description: 'Path to the Godot project directory', check: 'project' };

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
    Object.entries(tool.params).map(([name, { check, label, hint, type, ...schema }]) => [name, type === 'any' ? schema : { type, ...schema }])
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

  for (const [name, param] of Object.entries(tool.params)) {
    if (args[name] === undefined) {
      if (param.default !== undefined) args[name] = param.default;
    } else if (!fits(param, args[name])) {
      const expected = accepted(param);
      return { error: errorReply(`Invalid ${name}: expected ${expected}, got ${JSON.stringify(args[name])}`, [`Provide ${name} as ${expected}`]) };
    }
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
    } else if ((param.check === 'projectFile' || param.check === 'existingFile') && win32.isAbsolute(value)) {
      // win32 also recognizes POSIX absolute paths, so both are rejected on every platform
      return { error: errorReply(`Invalid path in ${name}: ${value}`, ['Provide the path relative to the project (e.g. "scenes/main.tscn") or as res://, not as an absolute path']) };
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
      return { error: errorReply(`Godot ${major}.${minor} or later is needed for ${feature}; this is ${version}`, solutions) };
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

/** Whether a value has the parameter's type, and is within its enum and bounds */
function fits(param: Param, value: unknown): boolean {
  const { type, items, enum: values, minimum = -Infinity, maximum = Infinity } = param;
  switch (type) {
    case 'string':
      return typeof value === 'string' && (!values || values.includes(value));
    case 'number':
    case 'integer':
      return (
        typeof value === 'number' &&
        (type === 'integer' ? Number.isInteger(value) : Number.isFinite(value)) &&
        value >= minimum &&
        value <= maximum
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value) && (!items || value.every((item) => typeof item === items.type));
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'any':
      return true;
  }
}

/** What a parameter accepts, e.g. "an integer from 0 to 60000" or "one of continue, step" */
function accepted({ type, items, enum: values, minimum, maximum }: Param): string {
  if (values) return `one of ${values.join(', ')}`;
  const kind = {
    string: 'a string',
    number: 'a number',
    integer: 'an integer',
    boolean: 'true or false',
    array: items ? `an array of ${items.type}s` : 'an array',
    object: 'an object',
    any: 'any value',
  }[type];
  if (minimum !== undefined && maximum !== undefined) return `${kind} from ${minimum} to ${maximum}`;
  if (minimum !== undefined) return `${kind} of at least ${minimum}`;
  if (maximum !== undefined) return `${kind} of at most ${maximum}`;
  return kind;
}

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
