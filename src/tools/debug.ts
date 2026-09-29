/**
 * Debug control tools: breakpoints, pausing, stepping and evaluating expressions in the running
 * game, through the remote debugger.
 */

import { DebugSession, ResumeAction } from '../debug-session.js';
import { ToolContext, ToolDefinition, ToolError, ToolReply, godotVersionAtLeast, jsonReply } from '../tool-requests.js';
import { requireSession, sessionUnavailable } from './runtime.js';

export function debugTools(ctx: ToolContext): ToolDefinition[] {
  return [
    {
      name: 'set_breakpoint',
      description:
        'Set or clear a breakpoint at a script line. Breakpoints are kept across runs and apply to the running game at once. ' +
        'While any is set, breakpoint statements in scripts pause the game too. Returns all breakpoints',
      params: {
        file: { type: 'string', description: 'Script path, relative to the project or res://', check: 'projectFile' },
        line: { type: 'integer', description: 'Line number (1-based)', minimum: 1 },
        enabled: { type: 'boolean', description: 'false clears the breakpoint (default: true)', default: true },
      },
      required: ['file', 'line'],
      failure: 'Failed to set the breakpoint',
      handle: async (args) => {
        const breakpoint = { file: args.file.startsWith('res://') ? args.file : `res://${args.file}`, line: args.line };
        const enabled: boolean = args.enabled;
        const key = `${breakpoint.file}:${breakpoint.line}`;
        if (enabled) ctx.breakpoints.set(key, breakpoint);
        else ctx.breakpoints.delete(key);

        ctx.runner.debugSession()?.setBreakpoint(breakpoint, enabled);
        return jsonReply({ breakpoints: [...ctx.breakpoints.values()] });
      },
    },
    {
      name: 'list_breakpoints',
      description: 'List the breakpoints that are set',
      params: {},
      required: [],
      failure: 'Failed to list breakpoints',
      handle: async () => jsonReply({ breakpoints: [...ctx.breakpoints.values()] }),
    },
    {
      name: 'pause_game',
      description: 'Pause the running game and return where it stopped, the call stack and the variables of the top frame',
      params: {},
      required: [],
      failure: 'Failed to pause the game',
      handle: async () => {
        const session = requireSession(ctx.runner);
        if (!session.isPaused && !(await session.pauseGame(3000))) throw new ToolError('The game did not pause within 3 s');
        return debugStateReply(ctx, session);
      },
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
          enum: ['continue', 'step', 'next', 'out'],
          default: 'continue',
        },
        waitMs: {
          type: 'number',
          description: 'How long to wait for the next pause, in ms (default: 5000, at most 60000)',
          minimum: 0,
          maximum: 60000,
          default: 5000,
        },
      },
      required: [],
      failure: 'Failed to resume the game',
      handle: async (args) => {
        const session = requireSession(ctx.runner);
        const action: ResumeAction = args.action;
        if (!session.isPaused) throw new ToolError('The game is not paused', ['Use pause_game, or set_breakpoint and get_debug_state with waitMs']);
        if (action === 'out' && !godotVersionAtLeast(await ctx.godotVersion(), [4, 6])) {
          throw new ToolError('Stepping out needs Godot 4.6 or later', ['Use next until the function returns']);
        }
        await session.resume(action, args.waitMs);
        return debugStateReply(ctx, session);
      },
    },
    {
      name: 'get_debug_state',
      description:
        'Whether the game is running, paused or exited, with the pause state when paused. waitMs waits for the game to pause ' +
        '(for example at a breakpoint); frame reads the variables of another stack frame',
      params: {
        waitMs: { type: 'number', description: 'Wait up to this many ms for a pause (default: 0, at most 60000)', minimum: 0, maximum: 60000, default: 0 },
        frame: { type: 'integer', description: 'Stack frame for the variables, 0 is the innermost (default: 0)', minimum: 0, default: 0 },
      },
      required: [],
      failure: 'Failed to get the debug state',
      handle: async (args) => {
        // Unlike other runtime tools, this one works before the game connects, and after it exits
        const session = ctx.runner.debugSession();
        if (!session) {
          const run = ctx.runner.snapshot();
          if (run && !run.running) return jsonReply({ status: 'exited', exitCode: run.exitCode });
          throw sessionUnavailable(ctx.runner.noSessionReason());
        }
        const frame: number = args.frame;
        if (session.isPaused) await session.capturedPause(3000);
        else if (args.waitMs) await session.nextPause(args.waitMs);
        if (frame !== 0) {
          const pause = session.pause;
          if (!pause) throw new ToolError('The game is not paused, so it has no stack frames to read');
          if (frame >= pause.stack.length) {
            throw new ToolError(`frame must be between 0 and ${pause.stack.length - 1}`);
          }
          return jsonReply({ status: 'paused', pause: { ...pause, frame, variables: await session.frameVariables(frame) } });
        }
        return debugStateReply(ctx, session);
      },
    },
    {
      name: 'evaluate',
      description:
        'Evaluate a GDScript expression in a frame of the paused game (Godot 4.4+). Godot returns null when the expression fails',
      params: {
        expression: { type: 'string', description: 'Expression, e.g. "direction * speed"' },
        frame: { type: 'integer', description: 'Stack frame, 0 is the innermost (default: 0)', minimum: 0, default: 0 },
      },
      required: ['expression'],
      failure: 'Failed to evaluate the expression',
      minGodot: { version: [4, 4], feature: 'evaluating expressions', solutions: ['Upgrade to Godot 4.4 or later to evaluate expressions'] },
      handle: async (args) => {
        const session = requireSession(ctx.runner);
        if (!session.pause) throw new ToolError('The game is not paused', ['Pause it first with pause_game or a breakpoint']);
        try {
          return jsonReply({ expression: args.expression, frame: args.frame, value: await session.evaluate(args.expression, args.frame) });
        } catch (error) {
          // Godot does not answer outside a script instance's frame (e.g. in a static function)
          throw new ToolError(`Godot did not evaluate the expression: ${error instanceof Error ? error.message : error}`, [
            'Godot evaluates only in frames that belong to a script instance',
          ]);
        }
      },
    },
  ];
}

/** The game's debug state: exited, running, or paused with the captured pause state */
function debugStateReply(ctx: ToolContext, session: DebugSession): ToolReply {
  const run = ctx.runner.snapshot();
  if (run && !run.running) return jsonReply({ status: 'exited', exitCode: run.exitCode });
  const pause = session.pause;
  if (pause) return jsonReply({ status: 'paused', pause });
  if (!session.isConnected) return jsonReply({ status: 'running', note: 'The game has not connected to the debugger yet' });
  return jsonReply({ status: session.isPaused ? 'pausing' : 'running' });
}
