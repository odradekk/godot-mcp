/**
 * The game run started by run_project: at most one at a time, with its output kept as lines.
 */

import { ChildProcess } from 'child_process';

import { Breakpoint, DebugSession, DebuggerStatus, ReportedError } from './debug-session.js';
import { GodotLauncher } from './godot-launcher.js';

const DEFAULT_MAX_LINES = 1000;
const DEFAULT_STOP_TIMEOUT_MS = 5000;

export interface RunSnapshot {
  running: boolean;
  exitCode: number | null;
  output: string[];
  errors: string[];
  /** Oldest lines discarded once a stream exceeded the line limit */
  droppedOutputLines: number;
  droppedErrorLines: number;
  debugger: DebuggerStatus;
  /** Errors and warnings the game reported through the debugger, repeats merged */
  reportedErrors: ReportedError[];
  /** Error reports not stored because the list of distinct errors was full */
  droppedReportedErrors: number;
}

/**
 * Whether to attach the remote debugger to a run: its settings, or why it is not attached.
 */
export type DebuggerSetup =
  | { ignoreErrorBreaks: boolean; inspectObjects: boolean; breakOnError: boolean; breakpoints: ReadonlyMap<string, Breakpoint> }
  | { unavailable: string };

/**
 * Lines of one output stream. A line may arrive over several chunks; empty lines are skipped and
 * only the most recent `maxLines` are kept.
 */
class LineLog {
  lines: string[] = [];
  dropped = 0;
  private partial = '';

  constructor(private maxLines: number) {}

  write(chunk: string) {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop()!;
    parts.forEach((line) => this.add(line));
  }

  /** Keep the last line even if the stream ended without a newline */
  end() {
    this.add(this.partial);
    this.partial = '';
  }

  private add(line: string) {
    if (line === '') return;
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
      this.dropped++;
    }
  }
}

interface Run {
  projectPath: string;
  process: ChildProcess;
  output: LineLog;
  errors: LineLog;
  running: boolean;
  exitCode: number | null;
  session: DebugSession | null;
  /** Why the run has no debug session */
  unattachedReason?: string;
  /** Resolves once the process has exited and its output has been read */
  finished: Promise<void>;
}

export class ProjectRunner {
  private current: Run | null = null;

  constructor(
    private launcher: GodotLauncher,
    private options: { maxLines?: number; stopTimeoutMs?: number; log?: (message: string) => void } = {}
  ) {}

  /**
   * Start a game run of the project at `projectPath`, passing `args` (e.g. a scene) after it, first
   * stopping the current run and waiting for it to exit. With a debugger setup, the game connects
   * to a debug session that listens before the game is launched.
   */
  async start(godotPath: string, projectPath: string, args: string[], debuggerSetup: DebuggerSetup): Promise<void> {
    await this.stop();
    args = ['--path', projectPath, ...args];

    let session: DebugSession | null = null;
    let unattachedReason: string | undefined;
    if ('unavailable' in debuggerSetup) {
      unattachedReason = debuggerSetup.unavailable;
    } else {
      session = new DebugSession({ ...debuggerSetup, log: this.options.log });
      try {
        const port = await session.listen();
        args = ['--remote-debug', `tcp://127.0.0.1:${port}`, ...args];
      } catch (error) {
        session.close();
        session = null;
        unattachedReason = `Could not listen for the debugger: ${error instanceof Error ? error.message : error}`;
      }
    }

    const maxLines = this.options.maxLines ?? DEFAULT_MAX_LINES;
    const process = this.launcher.start(godotPath, args);
    const output = new LineLog(maxLines);
    const errors = new LineLog(maxLines);
    let finish!: (exitCode: number | null) => void;
    const run: Run = {
      projectPath,
      process,
      output,
      errors,
      running: true,
      exitCode: null,
      session,
      unattachedReason,
      finished: new Promise((resolve) => {
        finish = (exitCode) => {
          if (!run.running) return;
          output.end();
          errors.end();
          run.running = false;
          run.exitCode = exitCode;
          session?.close();
          this.options.log?.(`Godot process exited with code ${exitCode}`);
          resolve();
        };
      }),
    };

    process.stdout?.setEncoding('utf8');
    process.stdout?.on('data', (chunk: string) => output.write(chunk));
    process.stderr?.setEncoding('utf8');
    process.stderr?.on('data', (chunk: string) => errors.write(chunk));
    // 'close' comes after the stdio streams are drained, so the last lines are already read
    process.on('close', (code: number | null) => finish(code));
    process.on('error', (error: Error) => {
      // Only a process that never started is finished by an error; a failed kill is not an exit
      if (process.pid === undefined) {
        errors.write(`${error.message}\n`);
        finish(null);
      }
    });

    this.current = run;
  }

  /**
   * The current or last run, or null if no run has been started.
   */
  snapshot(): RunSnapshot | null {
    const run = this.current;
    if (!run) return null;
    return {
      running: run.running,
      exitCode: run.exitCode,
      output: [...run.output.lines],
      errors: [...run.errors.lines],
      droppedOutputLines: run.output.dropped,
      droppedErrorLines: run.errors.dropped,
      debugger: run.session?.status() ?? { attached: false, reason: run.unattachedReason },
      reportedErrors: run.session?.reportedErrors() ?? [],
      droppedReportedErrors: run.session?.droppedErrorReports ?? 0,
    };
  }

  /** The project of the current or last run; null if no run has been started */
  projectPath(): string | null {
    return this.current?.projectPath ?? null;
  }

  /**
   * The debug session of the running game, connected or not yet; null if there is none
   */
  debugSession(): DebugSession | null {
    const run = this.current;
    return run?.running ? run.session : null;
  }

  /**
   * Why debugSession() is null
   */
  noSessionReason(): string {
    const run = this.current;
    if (!run) return 'No game has been started. Use run_project first.';
    if (!run.running) return `The game is not running; it exited with code ${run.exitCode}. Use run_project to start it again.`;
    return run.unattachedReason ?? 'The remote debugger is not attached';
  }

  /**
   * Stop the running game: send SIGTERM, and SIGKILL if it has not exited within stopTimeoutMs,
   * then wait up to stopTimeoutMs again. Returns the final snapshot (still running if the process
   * outlived both), or null if no game is running.
   */
  async stop(): Promise<RunSnapshot | null> {
    const run = this.current;
    if (!run?.running) return null;

    // SIGKILL ensures no game outlives stop_project, the next run_project or the server. On Windows
    // the first kill already ends the process, whatever the signal.
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      run.process.kill(signal);
      if (await exitsWithin(run, this.stopTimeoutMs)) break;
    }
    return this.snapshot();
  }

  get stopTimeoutMs(): number {
    return this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }
}

/** Wait up to `ms` for the run's process to exit; returns whether it did */
async function exitsWithin(run: Run, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([run.finished, timeout]);
  clearTimeout(timer);
  return !run.running;
}
