/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { GodotLauncher, nodeLauncher } from './godot-launcher.js';
import { findGodot, readGodotVersion } from './godot-path.js';
import { ProjectRunner } from './godot-run.js';
import { ToolContext, ToolDefinition, ToolError, ToolReply, errorReply, inputSchema, prepareRequest } from './tool-requests.js';
import { debugTools } from './tools/debug.js';
import { projectTools } from './tools/project.js';
import { runTools } from './tools/run.js';
import { runtimeTools } from './tools/runtime.js';
import { sceneTools } from './tools/scene.js';

const DEFAULT_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;

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
  /**
   * How long stop_project, run_project and shutdown wait for the game to exit after SIGTERM, and
   * again after SIGKILL, in milliseconds. Defaults to 5 seconds.
   */
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
  private launcher: GodotLauncher;
  private env: NodeJS.ProcessEnv;
  private debugMode: boolean;

  constructor(private config: GodotServerConfig = {}) {
    this.env = config.env ?? process.env;
    this.launcher = config.launcher ?? nodeLauncher;
    this.debugMode = config.debugMode ?? this.env.DEBUG === 'true';
    this.runner = new ProjectRunner(this.launcher, {
      stopTimeoutMs: config.stopTimeoutMs,
      log: (message) => this.logDebug(message),
    });
    this.server = new Server({ name: 'godot-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
    this.server.onerror = (error) => console.error('[MCP Error]', error);
  }

  /**
   * Find the Godot executable, then serve MCP requests on the given transport.
   * Rejects when no valid Godot executable is found and strictPathValidation is on.
   */
  async connect(transport: Transport) {
    const log = (message: string) => this.logDebug(message);
    const godotPath = await findGodot({
      configured: this.config.godotPath,
      env: this.env,
      platform: this.config.platform ?? process.platform,
      launcher: this.launcher,
      strict: this.config.strictPathValidation ?? false,
      log,
    });
    console.error(`[SERVER] Using Godot at: ${godotPath}`);

    let version: Promise<string> | null = null;
    const ctx: ToolContext = {
      godotPath,
      // Read once per server; a failed read is retried
      godotVersion: () =>
        (version ??= readGodotVersion(this.launcher, godotPath).catch((error) => {
          version = null;
          throw error;
        })),
      launcher: this.launcher,
      runner: this.runner,
      breakpoints: new Map(),
      remoteDebugger: this.config.remoteDebugger ?? true,
      operationTimeoutMs: this.config.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      debugMode: this.debugMode,
      log,
    };
    this.registerTools(ctx, [...projectTools(ctx), ...runTools(ctx), ...sceneTools(ctx), ...runtimeTools(ctx), ...debugTools(ctx)]);
    await this.server.connect(transport);
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
   * Register the tool list and route tool calls through request preparation
   */
  private registerTools(ctx: ToolContext, list: ToolDefinition[]) {
    const tools = new Map(list.map((tool) => [tool.name, tool]));

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: list.map((tool) => ({
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
        const prepared = await prepareRequest(tool, request.params.arguments ?? {}, ctx.godotVersion);
        if ('error' in prepared) {
          return this.withPauseNote(prepared.error);
        }
        return this.withPauseNote(await tool.handle(prepared.args));
      } catch (error: unknown) {
        if (error instanceof ToolError) {
          return this.withPauseNote(errorReply(error.message, error.solutions, error.details));
        }
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return errorReply(`${tool.failure}: ${errorMessage}`, [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]);
      }
    });
  }

  /**
   * Prepend a note to a reply while the game is paused, so the agent never leaves it paused unknowingly
   */
  private withPauseNote(reply: ToolReply): ToolReply {
    const session = this.runner.debugSession();
    if (!session?.isPaused) return reply;
    const top = session.pause?.stack[0];
    const where = top ? ` at ${top.file}:${top.line} (${top.function})` : '';
    return { ...reply, content: [{ type: 'text', text: `Game paused${where}; use resume_game to continue` }, ...reply.content] };
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
}
