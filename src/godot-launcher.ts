import { execFile, spawn, ChildProcess } from 'child_process';

/**
 * Starts Godot processes. The server launches Godot only through this interface,
 * so tests can substitute a fake.
 */
export interface GodotLauncher {
  /**
   * Run a command to completion. Resolves with the output and exit code whenever the process
   * exits, including with a non-zero code. Rejects when the process cannot start, times out,
   * exceeds the output limit, or is killed by a signal; the error message says which.
   */
  run(
    file: string,
    args: string[],
    options?: { timeoutMs?: number; maxBufferBytes?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;

  /**
   * Start a long-running process with piped stdio. With `detached`, the process gets no stdio and
   * its own process group, and keeps running after this server exits.
   */
  start(file: string, args: string[], options?: { detached?: boolean }): ChildProcess;
}

export const nodeLauncher: GodotLauncher = {
  run(file, args, options = {}) {
    const { timeoutMs, maxBufferBytes } = options;
    return new Promise((resolve, reject) => {
      // Argument arrays are passed to the executable directly, with no shell interpretation
      execFile(file, args, { timeout: timeoutMs, maxBuffer: maxBufferBytes }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
        } else if (typeof error.code === 'number') {
          // execFile reports a non-zero exit as an error carrying the numeric exit code
          resolve({ stdout, stderr, exitCode: error.code });
        } else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new Error(`Godot output exceeded ${(maxBufferBytes ?? 1024 * 1024) / (1024 * 1024)} MiB and the process was stopped`));
        } else if (error.killed && timeoutMs !== undefined) {
          reject(new Error(`Godot timed out after ${timeoutMs / 1000} s and the process was stopped`));
        } else {
          // Start failures (e.g. ENOENT) and signal kills
          reject(error);
        }
      });
    });
  },

  start(file, args, options = {}) {
    if (options.detached) {
      // Without detached, Windows ends the child when this process exits (libuv's job object)
      const child = spawn(file, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return child;
    }
    return spawn(file, args, { stdio: 'pipe' });
  },
};
