import { execFile, spawn, ChildProcess } from 'child_process';

/**
 * Starts Godot processes. The server launches Godot only through this interface,
 * so tests can substitute a fake.
 */
export interface GodotLauncher {
  /**
   * Run a command to completion. Resolves with the output and exit code whenever the process
   * exits, including with a non-zero code. Rejects when the process cannot start, times out,
   * or is killed by a signal.
   */
  run(
    file: string,
    args: string[],
    options?: { timeoutMs?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;

  /**
   * Start a long-running process with piped stdio.
   */
  start(file: string, args: string[]): ChildProcess;
}

export const nodeLauncher: GodotLauncher = {
  run(file, args, options = {}) {
    return new Promise((resolve, reject) => {
      // Argument arrays are passed to the executable directly, with no shell interpretation
      execFile(file, args, { timeout: options.timeoutMs }, (error, stdout, stderr) => {
        // execFile reports a non-zero exit as an error carrying the numeric exit code.
        // Start failures (e.g. ENOENT) have a string code; signal kills and timeouts have none.
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ stdout, stderr, exitCode: error ? (error.code as number) : 0 });
      });
    });
  },

  start(file, args) {
    return spawn(file, args, { stdio: 'pipe' });
  },
};
