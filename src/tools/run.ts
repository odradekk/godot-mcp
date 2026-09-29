/**
 * Running the project: start it, with the remote debugger attached where Godot supports it, read
 * its output, and stop it.
 */

import { DebuggerSetup } from '../godot-run.js';
import { ToolContext, ToolDefinition, ToolError, godotVersionAtLeast, jsonReply, projectPathParam, textReply } from '../tool-requests.js';
import { sceneFile } from './scene.js';

export function runTools(ctx: ToolContext): ToolDefinition[] {
  return [
    {
      name: 'run_project',
      description: 'Run the Godot project and capture output',
      params: {
        projectPath: projectPathParam,
        scene: sceneFile('Optional: Specific scene to run'),
        breakOnError: {
          type: 'boolean',
          description: 'Pause the game on script errors instead of running through them, to inspect the failing frame (default: false; needs the remote debugger)',
          default: false,
        },
      },
      required: ['projectPath'],
      failure: 'Failed to run Godot project',
      handle: async (args) => {
        // No -d: the local debugger would stop the game at the first script error and wait for commands
        // on stdin, which no tool can send. Errors and their GDScript backtraces still reach stderr.
        const cmdArgs = ['--path', args.projectPath];
        if (args.scene) {
          cmdArgs.push(args.scene);
        }
        ctx.log(`Running Godot project: ${cmdArgs.join(' ')}`);
        await ctx.runner.start(ctx.godotPath, cmdArgs, await debuggerSetup(ctx, args.breakOnError));
        return textReply(`Godot project started. Use get_debug_output to see its output and errors.`);
      },
    },
    {
      name: 'get_debug_output',
      description: 'Get the current debug output and errors. With the remote debugger attached, reportedErrors lists each distinct error and warning once, with its script file, line and count',
      params: {},
      required: [],
      failure: 'Failed to get debug output',
      handle: async () => {
        const run = ctx.runner.snapshot();
        if (!run) throw new ToolError('No Godot process has been started.', ['Use run_project to start a Godot project first']);
        return jsonReply(run);
      },
    },
    {
      name: 'stop_project',
      description: 'Stop the currently running Godot project',
      params: {},
      required: [],
      failure: 'Failed to stop Godot project',
      handle: async () => {
        const snapshot = await ctx.runner.stop();
        if (!snapshot) {
          throw new ToolError('No running Godot process to stop.', [
            'Use run_project to start a Godot project first',
            'The process may have already terminated; use get_debug_output to read its output',
          ]);
        }
        const seconds = ctx.runner.stopTimeoutMs / 1000;
        const { output: finalOutput, errors: finalErrors, ...run } = snapshot;
        const message = run.running
          ? `Godot project did not exit within ${seconds} s of SIGTERM or ${seconds} s of SIGKILL`
          : 'Godot project stopped';
        return jsonReply({ message, ...run, finalOutput, finalErrors });
      },
    },
  ];
}

/**
 * Whether run_project attaches the remote debugger, given the configuration and Godot version
 */
async function debuggerSetup(ctx: ToolContext, breakOnError: boolean): Promise<DebuggerSetup> {
  if (!ctx.remoteDebugger) {
    return { unavailable: 'The remote debugger is turned off in the server configuration' };
  }
  let version: string;
  try {
    version = await ctx.godotVersion();
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
  return { ignoreErrorBreaks: godot45, inspectObjects: godot45, breakOnError, breakpoints: ctx.breakpoints };
}
