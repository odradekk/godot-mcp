/**
 * One-shot Godot runs: operations of godot_operations.gd, which reports its outcome on stdout, and
 * other runs such as the editor's import.
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { ToolArgs, ToolContext, ToolDefinition, ToolError, textReply } from './tool-requests.js';

const OPERATION_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
// Lines of Godot output attached to failure replies
const LOG_TAIL_LINES = 40;
// Prefix of the stdout line on which godot_operations.gd reports its outcome
const RESULT_MARKER = '@@GODOT_MCP_RESULT@@ ';
const OPERATIONS_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'godot_operations.gd');

type GodotRun = { stdout: string; stderr: string; exitCode: number };

/**
 * What a finished run produced, or why it failed. `log` is the rest of Godot's output.
 */
type Outcome = { ok: true; result: unknown; log: string } | { ok: false; error: string; log: string };

/**
 * A tool whose whole job is the godot_operations.gd operation of the same name, run with every
 * argument except projectPath. Success replies with `render(result)`.
 */
export function operationTool<R>(
  ctx: ToolContext,
  tool: Omit<ToolDefinition, 'handle'> & { solutions: string[]; render(result: R, args: ToolArgs): string }
): ToolDefinition {
  const { solutions, render, ...definition } = tool;
  return {
    ...definition,
    handle: async (args) => {
      const { projectPath, ...params } = args;
      return textReply(render(await scriptOperation<R>(ctx, tool.name, params, projectPath, tool.failure, solutions), args));
    },
  };
}

/**
 * Run a godot_operations.gd operation and return the result it reported, which the caller states
 * the type of. Throws ToolError led by `failure` when the operation fails or reports nothing.
 */
export async function scriptOperation<R>(
  ctx: ToolContext,
  operation: string,
  params: ToolArgs,
  projectPath: string,
  failure: string,
  solutions: string[]
): Promise<R> {
  // An argument array reaches Godot without shell interpretation, and arguments after "--" reach
  // the script, not Godot
  const args = ['--headless', '--path', projectPath, '--script', OPERATIONS_SCRIPT, '--', operation, JSON.stringify(params)];
  if (ctx.debugMode) args.push('--debug-godot');
  ctx.log(`Executing: ${ctx.godotPath} ${args.join(' ')}`);
  return (await runGodot(ctx, args, readOperationOutcome, failure, solutions)) as R;
}

/**
 * Run the editor's import of a project, which also writes missing .uid files. Throws ToolError led
 * by `failure` when Godot exits with an error.
 */
export async function importProject(ctx: ToolContext, projectPath: string, failure: string, solutions: string[]): Promise<void> {
  await runGodot(
    ctx,
    ['--headless', '--path', projectPath, '--import'],
    ({ stdout, stderr, exitCode }) => {
      const log = `${stdout}\n${stderr}`.trim();
      return exitCode === 0
        ? { ok: true, result: null, log }
        : { ok: false, error: withStderrTail(`Godot import exited with code ${exitCode}`, stderr), log };
    },
    failure,
    solutions
  );
}

/**
 * Run Godot to completion and return the result `read` finds in the run. A failed run, or one the
 * launcher rejects (timeout, output limit, start failure), throws ToolError led by `failure`, with
 * Godot's output in debug mode.
 */
async function runGodot(
  ctx: ToolContext,
  args: string[],
  read: (run: GodotRun) => Outcome,
  failure: string,
  solutions: string[]
): Promise<unknown> {
  let outcome: Outcome;
  try {
    outcome = read(
      await ctx.launcher.run(ctx.godotPath, args, { timeoutMs: ctx.operationTimeoutMs, maxBufferBytes: OPERATION_OUTPUT_LIMIT_BYTES })
    );
  } catch (error: unknown) {
    outcome = { ok: false, error: error instanceof Error ? error.message : String(error), log: '' };
  }
  if (outcome.ok) return outcome.result;
  const details = ctx.debugMode && outcome.log ? `Godot output (last ${LOG_TAIL_LINES} lines):\n${lastLines(outcome.log, LOG_TAIL_LINES)}` : undefined;
  throw new ToolError(`${failure}: ${outcome.error}`, solutions, details);
}

/**
 * Interpret a finished run of godot_operations.gd. The last result line on stdout decides the
 * outcome, whatever the exit code; a run without one (Godot crashed or failed before the script
 * could report) is a failure.
 */
function readOperationOutcome({ stdout, stderr, exitCode }: GodotRun): Outcome {
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

function lastLines(text: string, count: number): string {
  return text.trim().split(/\r?\n/).slice(-count).join('\n');
}

function withStderrTail(message: string, stderr: string): string {
  const tail = lastLines(stderr, LOG_TAIL_LINES);
  return tail ? `${message}. Godot stderr:\n${tail}` : message;
}
