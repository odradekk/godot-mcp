/**
 * The game run started by run_project: at most one at a time, with its output kept as lines.
 */

import { ChildProcess } from 'child_process';

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
}

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
  process: ChildProcess;
  output: LineLog;
  errors: LineLog;
  running: boolean;
  exitCode: number | null;
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
   * Start a game run, first stopping the current one and waiting for it to exit.
   */
  async start(godotPath: string, args: string[]): Promise<void> {
    await this.stop();

    const maxLines = this.options.maxLines ?? DEFAULT_MAX_LINES;
    const process = this.launcher.start(godotPath, args);
    const output = new LineLog(maxLines);
    const errors = new LineLog(maxLines);
    let finish!: (exitCode: number | null) => void;
    const run: Run = {
      process,
      output,
      errors,
      running: true,
      exitCode: null,
      finished: new Promise((resolve) => {
        finish = (exitCode) => {
          if (!run.running) return;
          output.end();
          errors.end();
          run.running = false;
          run.exitCode = exitCode;
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
    };
  }

  /**
   * Kill the running game and wait up to stopTimeoutMs for it to exit. Returns the final snapshot
   * (still running if the process did not exit in time), or null if no game is running.
   */
  async stop(): Promise<RunSnapshot | null> {
    const run = this.current;
    if (!run?.running) return null;

    run.process.kill();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.stopTimeoutMs);
    });
    await Promise.race([run.finished, timeout]);
    clearTimeout(timer);
    return this.snapshot();
  }

  get stopTimeoutMs(): number {
    return this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }
}
