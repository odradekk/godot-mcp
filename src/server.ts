/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, normalize } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { GodotLauncher, nodeLauncher } from './godot-launcher.js';
import { Breakpoint, DebugSession, PauseState, RemoteNode, RemoteProperty, ResumeAction } from './debug-session.js';
import { VariantType } from './variant.js';
import { DebuggerSetup, ProjectRunner } from './godot-run.js';
import { SETTABLE_TYPES, inferVariantType, jsonToVariant, variantToJson } from './runtime-values.js';
import { Param, ToolArgs, ToolDefinition, ToolReply, errorReply, godotVersionAtLeast, inputSchema, prepareRequest } from './tool-requests.js';

// How godot_operations.gd resolves node paths; stated in every node path parameter
const NODE_PATH_RULE = 'Node paths: "" or "root" is the scene root, and a leading "root/" is optional, so "root/Player" and "Player" are the same node.';

// Property usage flags (Godot's PropertyUsageFlags) and the hint Godot sends for values too big to send
const PROPERTY_USAGE_STORAGE = 1 << 1;
const PROPERTY_USAGE_GROUPING = (1 << 6) | (1 << 7) | (1 << 8); // group, category, subgroup
const PROPERTY_USAGE_SCRIPT_VARIABLE = 1 << 12;
const PROPERTY_HINT_OBJECT_TOO_BIG = 25;
const RUNTIME_PATH_RULE =
  'An absolute path in the running game as get_scene_tree shows it, e.g. "/root/Main/Player" (the leading "/" is optional). ' +
  'The running tree starts at the window "root", with autoloads next to the main scene; this differs from the scene-file tools.';

const DEFAULT_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;
const OPERATION_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
// Lines of Godot output attached to failure replies
const LOG_TAIL_LINES = 40;
// Prefix of the stdout line on which godot_operations.gd reports its outcome
const RESULT_MARKER = '@@GODOT_MCP_RESULT@@ ';

/**
 * Outcome of one run of godot_operations.gd. `log` is the rest of Godot's output.
 */
type OperationOutcome =
  | { ok: true; result: any; log: string }
  | { ok: false; error: string; log: string };

function lastLines(text: string, count: number): string {
  return text.trim().split(/\r?\n/).slice(-count).join('\n');
}

function withStderrTail(message: string, stderr: string): string {
  const tail = lastLines(stderr, LOG_TAIL_LINES);
  return tail ? `${message}. Godot stderr:\n${tail}` : message;
}

/**
 * Interpret a finished run of godot_operations.gd. The last result line on stdout decides the
 * outcome, whatever the exit code; a run without one (Godot crashed or failed before the script
 * could report) is a failure.
 */
function readOperationOutcome({ stdout, stderr, exitCode }: { stdout: string; stderr: string; exitCode: number }): OperationOutcome {
  const lines = stdout.split(/\r?\n/);
  const reports = lines.filter((line) => line.startsWith(RESULT_MARKER));
  const log = [...lines.filter((line) => !line.startsWith(RESULT_MARKER)), stderr].join('\n').trim();

  const report = reports.pop();
  if (report === undefined) {
    return { ok: false, error: withStderrTail(`Godot exited with code ${exitCode} without reporting a result`, stderr), log };
  }
  try {
    const outcome = JSON.parse(report.slice(RESULT_MARKER.length));
    return outcome.ok ? { ok: true, result: outcome.result, log } : { ok: false, error: String(outcome.error), log };
  } catch {
    return { ok: false, error: `Godot reported an unreadable result: ${report}`, log };
  }
}

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Interface for server configuration
 */
export interface GodotServerConfig {
  godotPath?: string;
  /** Log debug messages to stderr. Defaults to DEBUG=true in `env`. */
  debugMode?: boolean;
  strictPathValidation?: boolean; // New option to control path validation behavior
  /** Platform whose install locations are searched for Godot. Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Source of GODOT_PATH, DEBUG, HOME and USERPROFILE. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Starts Godot processes. Defaults to child_process. */
  launcher?: GodotLauncher;
  /** Time limit for one Godot operation or import, in milliseconds. Defaults to 5 minutes. */
  operationTimeoutMs?: number;
  /** How long stop_project and shutdown wait for the game to exit after killing it, in milliseconds. Defaults to 5 seconds. */
  stopTimeoutMs?: number;
  /** Attach Godot's remote debugger to games started by run_project (Godot 4.2+). Defaults to true. */
  remoteDebugger?: boolean;
}

/**
 * Main server class for the Godot MCP server
 */
export class GodotServer {
  private server: Server;
  private runner: ProjectRunner;
  private remoteDebugger: boolean;
  // Kept by the server, so they apply to every run
  private breakpoints = new Map<string, Breakpoint>();
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private strictPathValidation: boolean;
  private debugMode: boolean;
  private platform: NodeJS.Platform;
  private env: NodeJS.ProcessEnv;
  private launcher: GodotLauncher;
  private operationTimeoutMs: number;
  private godotVersion: Promise<string> | null = null;

  constructor(config: GodotServerConfig = {}) {
    this.env = config.env ?? process.env;
    this.platform = config.platform ?? process.platform;
    this.launcher = config.launcher ?? nodeLauncher;
    this.debugMode = config.debugMode ?? this.env.DEBUG === 'true';
    this.strictPathValidation = config.strictPathValidation ?? false;
    this.operationTimeoutMs = config.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.remoteDebugger = config.remoteDebugger ?? true;
    this.runner = new ProjectRunner(this.launcher, {
      stopTimeoutMs: config.stopTimeoutMs,
      log: (message) => this.logDebug(message),
    });

    // Validated with --version when the server connects; an invalid path falls back to detection
    if (config.godotPath) {
      this.godotPath = normalize(config.godotPath);
      this.logDebug(`Custom Godot path provided: ${this.godotPath}`);
    }

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
    this.logDebug(`Operations script path: ${this.operationsScriptPath}`);

    // Initialize the MCP server
    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
  }

  /**
   * Log debug messages if debug mode is enabled
   * Using stderr instead of stdout to avoid interfering with JSON-RPC communication
   */
  private logDebug(message: string): void {
    if (this.debugMode) {
      console.error(`[DEBUG] ${message}`);
    }
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    // Check cache first
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      this.logDebug(`Validating Godot path: ${path}`);

      // A missing file makes the launcher reject, so no separate existence check is needed
      const { exitCode } = await this.launcher.run(path, ['--version']);
      const valid = exitCode === 0;

      this.logDebug(`${valid ? 'Valid' : 'Invalid'} Godot path: ${path}`);
      this.validatedPaths.set(path, valid);
      return valid;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    // If godotPath is already set and valid, use it
    if (this.godotPath && await this.isValidGodotPath(this.godotPath)) {
      this.logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    // Check environment variable next
    if (this.env.GODOT_PATH) {
      const normalizedPath = normalize(this.env.GODOT_PATH);
      this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      } else {
        this.logDebug(`GODOT_PATH environment variable is invalid`);
      }
    }

    // Auto-detect based on platform
    const osPlatform = this.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = [
      'godot', // Check if 'godot' is in PATH first
    ];

    // Add platform-specific paths
    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${this.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${this.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
        `${this.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot_4\\Godot.exe',
        'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
        `${this.env.USERPROFILE}\\Godot\\Godot.exe`
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${this.env.HOME}/.local/bin/godot`
      );
    }

    // Try each possible path
    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    // If we get here, we couldn't find Godot
    this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`);

    if (this.strictPathValidation) {
      // In strict mode, throw an error
      throw new Error(`Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`);
    } else {
      // Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }

      this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`);
    }
  }

  /**
   * Stop the running project, if any, and close the MCP connection
   */
  async close() {
    this.logDebug('Cleaning up resources');
    await this.runner.stop();
    await this.server.close();
  }

  /**
   * The version string `godot --version` reports. Read once per server; a failed read is retried.
   */
  private getGodotVersion(): Promise<string> {
    this.godotVersion ??= this.readGodotVersion().catch((error) => {
      this.godotVersion = null;
      throw error;
    });
    return this.godotVersion;
  }

  private async readGodotVersion(): Promise<string> {
    const { stdout, stderr, exitCode } = await this.launcher.run(this.godotPath!, ['--version'], { timeoutMs: 10000 });
    if (exitCode !== 0) {
      throw new Error(`godot --version exited with code ${exitCode}: ${stderr.trim()}`);
    }
    return stdout.trim();
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The result the operation reported, or why it failed
   */
  private async executeOperation(
    operation: string,
    params: ToolArgs,
    projectPath: string
  ): Promise<OperationOutcome> {
    this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    this.logDebug(`Operation params: ${JSON.stringify(params)}`);




    const paramsJson = JSON.stringify(params);

    // Build argument array for execFile to prevent command injection
    // Using execFile with argument arrays avoids shell interpretation entirely
    const args = [
      '--headless',
      '--path',
      projectPath,  // Safe: passed as argument, not interpolated into shell command
      '--script',
      this.operationsScriptPath,
      operation,
      paramsJson,  // Safe: passed as argument, not interpreted by shell
    ];


    if (this.debugMode) {
      args.push('--debug-godot');
    }

    this.logDebug(`Executing: ${this.godotPath} ${args.join(' ')}`);

    try {
      return readOperationOutcome(await this.launcher.run(this.godotPath!, args, {
        timeoutMs: this.operationTimeoutMs,
        maxBufferBytes: OPERATION_OUTPUT_LIMIT_BYTES,
      }));
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), log: '' };
    }
  }

  /**
   * Build the tool reply for an operation outcome. Success text comes from `render(result)`;
   * failures lead with the operation's own message, and include Godot's output in debug mode.
   */
  private operationReply(
    outcome: OperationOutcome,
    failurePrefix: string,
    possibleSolutions: string[],
    render: (result: any) => string
  ): ToolReply {
    if (outcome.ok) {
      return { content: [{ type: 'text', text: render(outcome.result) }] };
    }
    const response = errorReply(`${failurePrefix}: ${outcome.error}`, possibleSolutions);
    if (this.debugMode && outcome.log) {
      response.content.push({
        type: 'text',
        text: `Godot output (last ${LOG_TAIL_LINES} lines):\n${lastLines(outcome.log, LOG_TAIL_LINES)}`,
      });
    }
    return response;
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  private findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
    const projects: Array<{ path: string; name: string }> = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
  }

  /**
   * Register the tool list and route tool calls through request preparation
   */
  private setupToolHandlers() {
    const tools = new Map(this.defineTools().map((tool) => [tool.name, tool]));

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchema(tool),
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      const tool = tools.get(request.params.name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }

      try {
        const prepared = await prepareRequest(tool, request.params.arguments ?? {}, () => this.getGodotVersion());
        if ('error' in prepared) {
          return prepared.error;
        }
        return this.withPauseNote(await this.runTool(tool, prepared.args));
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return errorReply(`${tool.failure}: ${errorMessage}`, [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]);
      }
    });
  }

  private async runTool(tool: ToolDefinition, args: ToolArgs): Promise<ToolReply> {
    if (tool.operation) {
      const { projectPath, ...params } = args;
      const outcome = await this.executeOperation(tool.operation.name, params, projectPath);
      return this.operationReply(outcome, tool.failure, tool.operation.solutions, (result) =>
        tool.operation!.render(result, args)
      );
    }
    return tool.handle!(args);
  }

  /**
   * The tools this server offers, in the order they are listed
   */
  private defineTools(): ToolDefinition[] {
    const projectPath: Param = { type: 'string', description: 'Path to the Godot project directory', check: 'project' };
    const sceneFile = (description: string): Param => ({
      type: 'string',
      description,
      check: 'existingFile',
      label: 'Scene file',
      hint: 'Use create_scene to create a new scene first',
    });
    const noParams = { params: {}, required: [] };
    const uidSupport = {
      version: [4, 4] as [number, number],
      feature: 'UIDs',
      solutions: [
        'Upgrade to Godot 4.4 or later to use UIDs',
        'Use resource paths instead of UIDs for this version of Godot',
      ],
    };

    return [
      {
        name: 'launch_editor',
        description: 'Launch Godot editor for a specific project',
        params: { projectPath },
        required: ['projectPath'],
        failure: 'Failed to launch Godot editor',
        handle: (args) => this.handleLaunchEditor(args),
      },
      {
        name: 'run_project',
        description: 'Run the Godot project and capture output',
        params: {
          projectPath,
          scene: sceneFile('Optional: Specific scene to run'),
          breakOnError: {
            type: 'boolean',
            description: 'Pause the game on script errors instead of running through them, to inspect the failing frame (default: false; needs the remote debugger)',
          },
        },
        required: ['projectPath'],
        failure: 'Failed to run Godot project',
        handle: (args) => this.handleRunProject(args),
      },
      {
        name: 'get_debug_output',
        description: 'Get the current debug output and errors. With the remote debugger attached, reportedErrors lists each distinct error and warning once, with its script file, line and count',
        ...noParams,
        failure: 'Failed to get debug output',
        handle: () => this.handleGetDebugOutput(),
      },
      {
        name: 'stop_project',
        description: 'Stop the currently running Godot project',
        ...noParams,
        failure: 'Failed to stop Godot project',
        handle: () => this.handleStopProject(),
      },
      {
        name: 'get_godot_version',
        description: 'Get the installed Godot version',
        ...noParams,
        failure: 'Failed to get Godot version',
        handle: () => this.handleGetGodotVersion(),
      },
      {
        name: 'list_projects',
        description: 'List Godot projects in a directory',
        params: {
          directory: { type: 'string', description: 'Directory to search for Godot projects', check: 'directory' },
          recursive: { type: 'boolean', description: 'Whether to search recursively (default: false)' },
        },
        required: ['directory'],
        failure: 'Failed to list projects',
        handle: (args) => this.handleListProjects(args),
      },
      {
        name: 'get_project_info',
        description: 'Retrieve metadata about a Godot project',
        params: { projectPath },
        required: ['projectPath'],
        failure: 'Failed to get project info',
        handle: (args) => this.handleGetProjectInfo(args),
      },
      {
        name: 'create_scene',
        description: 'Create a new Godot scene file',
        params: {
          projectPath,
          scenePath: { type: 'string', description: 'Path where the scene file will be saved (relative to project)', check: 'projectFile' },
          rootNodeType: { type: 'string', description: 'Type of the root node (e.g., Node2D, Node3D)', check: 'className' },
        },
        required: ['projectPath', 'scenePath'],
        failure: 'Failed to create scene',
        operation: {
          name: 'create_scene',
          solutions: [
            'Check if the root node type is valid',
            'Ensure you have write permissions to the scene path',
            'Verify the scene path is valid',
          ],
          render: (result) => `Scene created successfully at: ${result.scenePath}`,
        },
      },
      {
        name: 'add_node',
        description: 'Add a node to an existing scene',
        params: {
          projectPath,
          scenePath: sceneFile('Path to the scene file (relative to project)'),
          parentNodePath: {
            type: 'string',
            description: `Path to the parent node (default: the scene root). ${NODE_PATH_RULE}`,
          },
          nodeType: { type: 'string', description: 'Type of node to add (e.g., Sprite2D, CollisionShape2D)', check: 'className' },
          nodeName: { type: 'string', description: 'Name for the new node' },
          properties: { type: 'object', description: 'Optional properties to set on the node' },
        },
        required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
        failure: 'Failed to add node',
        operation: {
          name: 'add_node',
          solutions: [
            'Check if the node type is valid',
            'Ensure the parent node path exists',
            'Verify the scene file is valid',
          ],
          render: (result, args) =>
            `Node '${args.nodeName}' of type '${result.nodeType}' added successfully at ${result.nodePath} in '${result.scenePath}'.`,
        },
      },
      {
        name: 'load_sprite',
        description: 'Load a sprite into a Sprite2D node',
        params: {
          projectPath,
          scenePath: sceneFile('Path to the scene file (relative to project)'),
          nodePath: {
            type: 'string',
            description: `Path to the Sprite2D, Sprite3D or TextureRect node (e.g., "root/Player/Sprite2D"). ${NODE_PATH_RULE}`,
          },
          texturePath: {
            type: 'string',
            description: 'Path to the texture file (relative to project)',
            check: 'existingFile',
            label: 'Texture file',
            hint: 'Upload or create the texture file first',
          },
        },
        required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
        failure: 'Failed to load sprite',
        operation: {
          name: 'load_sprite',
          solutions: [
            'Check if the node path is correct',
            'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
            'Verify the texture file is a valid image format',
          ],
          render: (result) =>
            `Sprite loaded successfully with texture: ${result.texturePath} on ${result.nodePath} in '${result.scenePath}'.`,
        },
      },
      {
        name: 'export_mesh_library',
        description: 'Export a scene as a MeshLibrary resource',
        params: {
          projectPath,
          scenePath: sceneFile('Path to the scene file (.tscn) to export'),
          outputPath: { type: 'string', description: 'Path where the mesh library (.res) will be saved', check: 'projectFile' },
          meshItemNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: Names of specific mesh items to include (defaults to all)',
          },
        },
        required: ['projectPath', 'scenePath', 'outputPath'],
        failure: 'Failed to export mesh library',
        operation: {
          name: 'export_mesh_library',
          solutions: [
            'Check if the scene contains valid 3D meshes',
            'Ensure the output path is valid',
            'Verify the scene file is valid',
          ],
          render: (result) =>
            `MeshLibrary exported successfully to: ${result.outputPath} (${result.items.length} items: ${result.items.join(', ')})`,
        },
      },
      {
        name: 'save_scene',
        description: 'Save changes to a scene file',
        params: {
          projectPath,
          scenePath: sceneFile('Path to the scene file (relative to project)'),
          newPath: { type: 'string', description: 'Optional: New path to save the scene to (for creating variants)', check: 'projectFile' },
        },
        required: ['projectPath', 'scenePath'],
        failure: 'Failed to save scene',
        operation: {
          name: 'save_scene',
          solutions: [
            'Check if the scene file is valid',
            'Ensure you have write permissions to the output path',
            'Verify the scene can be properly packed',
          ],
          render: (result) => `Scene saved successfully to: ${result.scenePath}`,
        },
      },
      {
        name: 'get_uid',
        description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
        params: {
          projectPath,
          filePath: { type: 'string', description: 'Path to the file (relative to project) for which to get the UID', check: 'existingFile' },
        },
        required: ['projectPath', 'filePath'],
        failure: 'Failed to get UID',
        minGodot: uidSupport,
        operation: {
          name: 'get_uid',
          solutions: ['Check if the file is a valid Godot resource', 'Ensure the file path is correct'],
          render: (result) => JSON.stringify(result, null, 2),
        },
      },
      {
        name: 'update_project_uids',
        description: 'Generate missing UIDs and resave resources in a Godot project (for Godot 4.4+)',
        params: { projectPath },
        required: ['projectPath'],
        failure: 'Failed to update project UIDs',
        minGodot: uidSupport,
        handle: (args) => this.handleUpdateProjectUids(args),
      },
      {
        name: 'get_scene_tree',
        description:
          'List the live scene tree of the game started by run_project, including autoloads and nodes created at runtime ' +
          '(needs the remote debugger, Godot 4.2+). Each node has its path, and its engine type or, for a scripted node, ' +
          'its script (a script with class_name shows as the type)',
        params: {
          path: { type: 'string', description: `Optional: list only this subtree. ${RUNTIME_PATH_RULE}` },
          maxNodes: { type: 'number', description: 'Maximum number of nodes to list (default: 500)' },
        },
        required: [],
        failure: 'Failed to get the scene tree',
        handle: (args) => this.handleGetSceneTree(args),
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
        handle: (args) => this.handleGetNodeProperties(args),
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
        handle: (args) => this.handleSetNodeProperty(args),
      },
      {
        name: 'set_breakpoint',
        description:
          'Set or clear a breakpoint at a script line. Breakpoints are kept across runs and apply to the running game at once. ' +
          'While any is set, breakpoint statements in scripts pause the game too. Returns all breakpoints',
        params: {
          file: { type: 'string', description: 'Script path, relative to the project or res://', check: 'projectFile' },
          line: { type: 'number', description: 'Line number (1-based)' },
          enabled: { type: 'boolean', description: 'false clears the breakpoint (default: true)' },
        },
        required: ['file', 'line'],
        failure: 'Failed to set the breakpoint',
        handle: (args) => this.handleSetBreakpoint(args),
      },
      {
        name: 'list_breakpoints',
        description: 'List the breakpoints that are set',
        params: {},
        required: [],
        failure: 'Failed to list breakpoints',
        handle: async () => jsonReply({ breakpoints: [...this.breakpoints.values()] }),
      },
      {
        name: 'pause_game',
        description: 'Pause the running game and return where it stopped, the call stack and the variables of the top frame',
        params: {},
        required: [],
        failure: 'Failed to pause the game',
        handle: () => this.handlePauseGame(),
      },
      {
        name: 'resume_game',
        description:
          'Continue or step the paused game, then wait for it to pause again. Returns the new pause state, ' +
          '"running" if it did not pause within waitMs, or "exited"',
        params: {
          action: {
            type: 'string',
            description: 'continue (default), step (into calls), next (over calls) or out (of the current function; Godot 4.6+)',
          },
          waitMs: { type: 'number', description: 'How long to wait for the next pause, in ms (default: 5000, at most 60000)' },
        },
        required: [],
        failure: 'Failed to resume the game',
        handle: (args) => this.handleResumeGame(args),
      },
      {
        name: 'get_debug_state',
        description:
          'Whether the game is running, paused or exited, with the pause state when paused. waitMs waits for the game to pause ' +
          '(for example at a breakpoint); frame reads the variables of another stack frame',
        params: {
          waitMs: { type: 'number', description: 'Wait up to this many ms for a pause (default: 0, at most 60000)' },
          frame: { type: 'number', description: 'Stack frame for the variables, 0 is the innermost (default: 0)' },
        },
        required: [],
        failure: 'Failed to get the debug state',
        handle: (args) => this.handleGetDebugState(args),
      },
      {
        name: 'evaluate',
        description:
          'Evaluate a GDScript expression in a frame of the paused game (Godot 4.4+). Godot returns null when the expression fails',
        params: {
          expression: { type: 'string', description: 'Expression, e.g. "direction * speed"' },
          frame: { type: 'number', description: 'Stack frame, 0 is the innermost (default: 0)' },
        },
        required: ['expression'],
        failure: 'Failed to evaluate the expression',
        handle: (args) => this.handleEvaluate(args),
      },
    ];
  }

  private async handleLaunchEditor(args: ToolArgs): Promise<ToolReply> {
    this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);
    // Detached: the editor belongs to the user and keeps running after this server exits
    const process = this.launcher.start(this.godotPath!, ['-e', '--path', args.projectPath], { detached: true });

    process.on('error', (err: Error) => {
      console.error('Failed to start Godot editor:', err);
    });

    return {
      content: [{ type: 'text', text: `Godot editor launched successfully for project at ${args.projectPath}.` }],
    };
  }

  private async handleRunProject(args: ToolArgs): Promise<ToolReply> {
    // No -d: the local debugger would stop the game at the first script error and wait for commands
    // on stdin, which no tool can send. Errors and their GDScript backtraces still reach stderr.
    const cmdArgs = ['--path', args.projectPath];
    if (args.scene) {
      cmdArgs.push(args.scene);
    }

    this.logDebug(`Running Godot project: ${cmdArgs.join(' ')}`);
    await this.runner.start(this.godotPath!, cmdArgs, await this.debuggerSetup(args.breakOnError === true));

    return {
      content: [{ type: 'text', text: `Godot project started. Use get_debug_output to see its output and errors.` }],
    };
  }

  /**
   * Whether run_project attaches the remote debugger, given the configuration and Godot version
   */
  private async debuggerSetup(breakOnError: boolean): Promise<DebuggerSetup> {
    if (!this.remoteDebugger) {
      return { unavailable: 'The remote debugger is turned off in the server configuration' };
    }
    let version: string;
    try {
      version = await this.getGodotVersion();
    } catch (error) {
      return { unavailable: `Could not read the Godot version: ${error instanceof Error ? error.message : error}` };
    }
    // 4.0 and 4.1 use an older message format
    if (!godotVersionAtLeast(version, [4, 2])) {
      return { unavailable: `The remote debugger needs Godot 4.2 or later; this is ${version}` };
    }
    // set_ignore_error_breaks and inspect_objects exist from 4.5; earlier versions get continue and
    // inspect_object instead
    const godot45 = godotVersionAtLeast(version, [4, 5]);
    return { ignoreErrorBreaks: godot45, inspectObjects: godot45, breakOnError, breakpoints: [...this.breakpoints.values()] };
  }

  /**
   * The running game's debug session, or the error reply saying why runtime tools cannot use it
   */
  private runtimeSession(): DebugSession | ToolReply {
    const session = this.runner.debugSession();
    if (session instanceof DebugSession && session.isConnected) return session;
    const reason = session instanceof DebugSession ? 'The game has not connected to the debugger yet; try again in a moment' : session.unavailable;
    return errorReply(reason, [
      'Runtime tools need a game started by run_project with the remote debugger attached (Godot 4.2+)',
      'get_debug_output shows whether the debugger is attached',
    ]);
  }

  private missingNodeReply(session: DebugSession, path: string): ToolReply {
    return errorReply(`No node at ${path} in the running game`, [
      `Closest paths: ${session.nearestPaths(path).join(', ')}`,
      'Use get_scene_tree to list the nodes',
    ]);
  }

  private async handleGetSceneTree(args: ToolArgs): Promise<ToolReply> {
    const session = this.runtimeSession();
    if (!(session instanceof DebugSession)) return session;

    let start = await session.sceneTree();
    if (args.path) {
      const path = runtimePath(args.path);
      const node = await session.findNode(path);
      if (!node) return this.missingNodeReply(session, path);
      start = node;
    }

    const maxNodes = args.maxNodes ?? 500;
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
    return jsonReply({
      tree,
      ...(omitted > 0 ? { omittedNodes: omitted, note: `Only ${maxNodes} nodes are listed; pass path for a subtree or raise maxNodes` } : {}),
    });
  }

  private async handleGetNodeProperties(args: ToolArgs): Promise<ToolReply> {
    const session = this.runtimeSession();
    if (!(session instanceof DebugSession)) return session;
    const path = runtimePath(args.nodePath);
    const node = await session.findNode(path);
    if (!node) return this.missingNodeReply(session, path);
    const inspected = await session.inspect(node.id);
    if (!inspected) return errorReply(`The node at ${path} no longer exists`, ['Use get_scene_tree to list the current nodes']);

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
    if (Array.isArray(args.names)) {
      const wanted = new Set(args.names.map(String));
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
  }

  private async handleSetNodeProperty(args: ToolArgs): Promise<ToolReply> {
    const session = this.runtimeSession();
    if (!(session instanceof DebugSession)) return session;
    const path = runtimePath(args.nodePath);
    const node = await session.findNode(path);
    if (!node) return this.missingNodeReply(session, path);
    const inspected = await session.inspect(node.id);
    if (!inspected) return errorReply(`The node at ${path} no longer exists`, ['Use get_scene_tree to list the current nodes']);

    const entry = inspected.properties.find((property) => listedProperty(property)?.name === args.property);
    if (!entry) {
      return errorReply(`${path} has no property or script variable named ${args.property}`, [
        'Use get_node_properties to list its script variables and properties',
      ]);
    }

    let value: unknown;
    try {
      // Script members arrive without a declared type
      const type = entry.type !== VariantType.NIL ? entry.type : inferVariantType(entry.value, args.value);
      value = jsonToVariant(type, args.value);
    } catch (error) {
      return errorReply(`Cannot set ${args.property}: ${error instanceof Error ? error.message : error}`);
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
  }

  /**
   * Prepend a note to a reply while the game is paused, so the agent never leaves it paused unknowingly
   */
  private withPauseNote(reply: ToolReply): ToolReply {
    const session = this.runner.debugSession();
    if (!(session instanceof DebugSession) || !session.isPaused) return reply;
    const top = session.pause?.stack[0];
    const where = top ? ` at ${top.file}:${top.line} (${top.function})` : '';
    return { ...reply, content: [{ type: 'text', text: `Game paused${where}; use resume_game to continue` }, ...reply.content] };
  }

  private async handleSetBreakpoint(args: ToolArgs): Promise<ToolReply> {
    if (!Number.isInteger(args.line) || args.line < 1) return errorReply(`line must be a positive whole number, got ${args.line}`);
    const breakpoint = { file: String(args.file).startsWith('res://') ? String(args.file) : `res://${args.file}`, line: args.line };
    const enabled = args.enabled !== false;
    const key = `${breakpoint.file}:${breakpoint.line}`;
    if (enabled) this.breakpoints.set(key, breakpoint);
    else this.breakpoints.delete(key);

    const session = this.runner.debugSession();
    if (session instanceof DebugSession) session.setBreakpoint(breakpoint, enabled);
    return jsonReply({ breakpoints: [...this.breakpoints.values()] });
  }

  private async handlePauseGame(): Promise<ToolReply> {
    const session = this.runtimeSession();
    if (!(session instanceof DebugSession)) return session;
    if (session.isPaused) return this.debugStateReply(session);
    const since = session.pauseNumber;
    session.pauseGame();
    if (!(await session.waitForPause(since, 3000))) return errorReply('The game did not pause within 3 s');
    return this.debugStateReply(session);
  }

  private async handleResumeGame(args: ToolArgs): Promise<ToolReply> {
    const session = this.runtimeSession();
    if (!(session instanceof DebugSession)) return session;
    const action = (args.action ?? 'continue') as ResumeAction;
    if (!['continue', 'step', 'next', 'out'].includes(action)) {
      return errorReply(`Unknown action ${action}`, ['Use continue, step, next or out']);
    }
    if (!session.isPaused) return errorReply('The game is not paused', ['Use pause_game, or set_breakpoint and get_debug_state with waitMs']);
    if (action === 'out' && !godotVersionAtLeast(await this.getGodotVersion(), [4, 6])) {
      return errorReply('Stepping out needs Godot 4.6 or later', ['Use next until the function returns']);
    }
    const since = session.pauseNumber;
    session.resume(action);
    await session.waitForPause(since, waitTime(args.waitMs, 5000));
    return this.debugStateReply(session);
  }

  private async handleGetDebugState(args: ToolArgs): Promise<ToolReply> {
    const session = this.runner.debugSession();
    if (!(session instanceof DebugSession)) {
      // An exited game still has a state to report
      const run = this.runner.snapshot();
      return run && !run.running ? jsonReply({ status: 'exited', exitCode: run.exitCode }) : this.runtimeSession() as ToolReply;
    }
    const frame = args.frame ?? 0;
    if (!session.isPaused && args.waitMs) await session.waitForPause(session.pauseNumber, waitTime(args.waitMs, 0));
    else if (session.isPaused && !session.pause) await session.waitForPause(session.pauseNumber - 1, 3000);
    if (frame !== 0) {
      const pause = session.pause;
      if (!pause) return errorReply('The game is not paused, so it has no stack frames to read');
      if (!Number.isInteger(frame) || frame < 0 || frame >= pause.stack.length) {
        return errorReply(`frame must be between 0 and ${pause.stack.length - 1}`);
      }
      return jsonReply({ status: 'paused', pause: { ...pause, frame, variables: await session.frameVariables(frame) } });
    }
    return this.debugStateReply(session);
  }

  private async handleEvaluate(args: ToolArgs): Promise<ToolReply> {
    const session = this.runtimeSession();
    if (!(session instanceof DebugSession)) return session;
    if (!session.pause) return errorReply('The game is not paused', ['Pause it first with pause_game or a breakpoint']);
    if (!godotVersionAtLeast(await this.getGodotVersion(), [4, 4])) return errorReply('Evaluating expressions needs Godot 4.4 or later');
    const frame = args.frame ?? 0;
    try {
      return jsonReply({ expression: args.expression, frame, value: await session.evaluate(String(args.expression), frame) });
    } catch (error) {
      // Godot does not answer outside a script instance's frame (e.g. in a static function)
      return errorReply(`Godot did not evaluate the expression: ${error instanceof Error ? error.message : error}`, [
        'Godot evaluates only in frames that belong to a script instance',
      ]);
    }
  }

  /** The game's debug state: exited, running, or paused with the captured pause state */
  private debugStateReply(session: DebugSession): ToolReply {
    const run = this.runner.snapshot();
    if (run && !run.running) return jsonReply({ status: 'exited', exitCode: run.exitCode });
    const pause: PauseState | null = session.pause;
    if (pause) return jsonReply({ status: 'paused', pause });
    if (!session.isConnected) return jsonReply({ status: 'running', note: 'The game has not connected to the debugger yet' });
    return jsonReply({ status: session.isPaused ? 'pausing' : 'running' });
  }

  private async handleGetDebugOutput(): Promise<ToolReply> {
    const run = this.runner.snapshot();
    if (!run) {
      return errorReply('No Godot process has been started.', ['Use run_project to start a Godot project first']);
    }
    return { content: [{ type: 'text', text: JSON.stringify(run, null, 2) }] };
  }

  private async handleStopProject(): Promise<ToolReply> {
    const run = await this.runner.stop();
    if (!run) {
      return errorReply('No running Godot process to stop.', [
        'Use run_project to start a Godot project first',
        'The process may have already terminated; use get_debug_output to read its output',
      ]);
    }

    const message = run.running
      ? `Godot project was killed but did not exit within ${this.runner.stopTimeoutMs / 1000} s`
      : 'Godot project stopped';
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message,
              running: run.running,
              exitCode: run.exitCode,
              finalOutput: run.output,
              finalErrors: run.errors,
              droppedOutputLines: run.droppedOutputLines,
              droppedErrorLines: run.droppedErrorLines,
              debugger: run.debugger,
              reportedErrors: run.reportedErrors,
              droppedReportedErrors: run.droppedReportedErrors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleGetGodotVersion(): Promise<ToolReply> {
    return { content: [{ type: 'text', text: await this.getGodotVersion() }] };
  }

  private async handleListProjects(args: ToolArgs): Promise<ToolReply> {
    this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
    const projects = this.findGodotProjects(args.directory, args.recursive === true);
    return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */
  private getProjectStructureAsync(projectPath: string): Promise<any> {
    return new Promise((resolve) => {
      try {
        const structure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        const scanDirectory = (currentPath: string) => {
          const entries = readdirSync(currentPath, { withFileTypes: true });

          for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);

            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }

            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(entryPath);
            } else if (entry.isFile()) {
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();

              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };

        // Start scanning from the project root
        scanDirectory(projectPath);
        resolve(structure);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${error}`);
        resolve({
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0
        });
      }
    });
  }

  private async handleGetProjectInfo(args: ToolArgs): Promise<ToolReply> {
    this.logDebug(`Getting project info for: ${args.projectPath}`);
    const godotVersion = await this.getGodotVersion();
    const projectStructure = await this.getProjectStructureAsync(args.projectPath);

    // Extract project name from project.godot file
    let projectName = basename(args.projectPath);
    try {
      const projectFileContent = readFileSync(join(args.projectPath, 'project.godot'), 'utf8');
      const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
      if (configNameMatch && configNameMatch[1]) {
        projectName = configNameMatch[1];
        this.logDebug(`Found project name in config: ${projectName}`);
      }
    } catch (error) {
      this.logDebug(`Error reading project file: ${error}`);
      // Continue with default project name if extraction fails
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              name: projectName,
              path: args.projectPath,
              godotVersion,
              structure: projectStructure,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleUpdateProjectUids(args: ToolArgs): Promise<ToolReply> {
    const failure = 'Failed to update project UIDs';
    const solutions = ['Check if the project is valid', 'Ensure you have write permissions to the project directory'];

    // The editor's filesystem scan writes missing .uid files; ResourceSaver does not outside the editor
    const importResult = await this.launcher.run(
      this.godotPath!,
      ['--headless', '--path', args.projectPath, '--import'],
      { timeoutMs: this.operationTimeoutMs, maxBufferBytes: OPERATION_OUTPUT_LIMIT_BYTES }
    );
    if (importResult.exitCode !== 0) {
      return this.operationReply(
        {
          ok: false,
          error: withStderrTail(`Godot import exited with code ${importResult.exitCode}`, importResult.stderr),
          log: `${importResult.stdout}\n${importResult.stderr}`.trim(),
        },
        failure,
        solutions,
        () => ''
      );
    }

    // The script scans res:// by default; args.projectPath is a disk path for --path and must not
    // be passed as the scan root.
    const outcome = await this.executeOperation('resave_resources', {}, args.projectPath);
    return this.operationReply(
      outcome,
      failure,
      solutions,
      (result) =>
        `Project UIDs updated successfully. Resaved ${result.scenesResaved} scenes; ${result.scriptsChecked} scripts and shaders have UIDs.`
    );
  }

  /**
   * Find the Godot executable, then serve MCP requests on the given transport.
   * Rejects when no valid Godot executable is found and strictPathValidation is on.
   */
  async connect(transport: Transport) {
    await this.detectGodotPath();
    console.error(`[SERVER] Using Godot at: ${this.godotPath}`);
    await this.server.connect(transport);
  }
}

function jsonReply(value: unknown): ToolReply {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
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

// A waitMs argument, bounded to 60 s
function waitTime(value: unknown, fallback: number): number {
  const ms = typeof value === 'number' && value >= 0 ? value : fallback;
  return Math.min(ms, 60000);
}
