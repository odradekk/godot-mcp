/**
 * The server's side of Godot's remote debugger protocol for one game run.
 *
 * The game connects to a TCP port the session listens on and exchanges length-prefixed Variant
 * messages `[name, thread_id, data]`. The session keeps the game from ever pausing, and collects
 * the errors and warnings the game reports, merging repeats.
 */

import net from 'net';

import { Variant, decodeVariant, encodeVariant } from './variant.js';

// Distinct errors kept per run; later reports are counted but not stored
const MAX_REPORTED_ERRORS = 200;

export interface ReportedError {
  message: string;
  /** The failed condition, when Godot reported one besides the message (ERR_FAIL_* macros) */
  condition?: string;
  warning: boolean;
  /** Top GDScript frame when there is one, otherwise where the engine raised it */
  file: string;
  line: number;
  function: string;
  /** Script call stack, when it has more than one frame */
  stack?: Array<{ file: string; line: number; function: string }>;
  count: number;
  /** Milliseconds since the run started */
  firstSeenMs: number;
  lastSeenMs: number;
}

export interface DebuggerStatus {
  attached: boolean;
  reason?: string;
}

export class DebugSession {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  // The game drops messages addressed to a thread it does not know, so reuse the one it sends
  private threadId: number | bigint = 0;
  private connected = false;
  private closed = false;
  private readonly startedAt = Date.now();
  private errors = new Map<string, ReportedError>();
  /** Error reports not stored because MAX_REPORTED_ERRORS distinct errors were already kept */
  droppedErrorReports = 0;

  constructor(private options: { ignoreErrorBreaks: boolean; log?: (message: string) => void }) {}

  /**
   * Listen on 127.0.0.1 on a port the OS picks, and resolve with it. Start this before launching
   * the game: a game that finds no listener starts about 3 s late.
   */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.accept(socket));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
      this.server = server;
    });
  }

  status(): DebuggerStatus {
    return this.connected ? { attached: true } : { attached: false, reason: 'The game has not connected to the debugger' };
  }

  reportedErrors(): ReportedError[] {
    return [...this.errors.values()].map((error) => ({ ...error }));
  }

  /**
   * Stop accepting connections and end the connection gracefully, so messages the game sent
   * before exiting are still read.
   */
  close() {
    this.closed = true;
    this.server?.close();
    this.socket?.end();
  }

  private accept(socket: net.Socket) {
    if (this.socket || this.closed) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    this.server?.close();

    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
        const length = pending.readUInt32LE(0);
        this.receive(pending.subarray(4, 4 + length));
        pending = pending.subarray(4 + length);
      }
    });
    socket.on('error', (error) => this.options.log?.(`Debugger connection error: ${error.message}`));
  }

  private receive(frame: Buffer) {
    let message: Variant;
    try {
      [message] = decodeVariant(frame);
    } catch (error) {
      this.options.log?.(`Skipping an undecodable debugger message: ${error instanceof Error ? error.message : error}`);
      return;
    }
    if (!Array.isArray(message) || message.length !== 3 || typeof message[0] !== 'string') {
      this.options.log?.('Skipping a debugger message that is not [name, thread_id, data]');
      return;
    }

    const [name, threadId, data] = message;
    if ((typeof threadId === 'number' || typeof threadId === 'bigint') && threadId) {
      this.threadId = threadId;
    }
    if (!this.connected) {
      this.connected = true;
      // Keep the game running through breakpoint statements and, where Godot allows it, errors
      this.send('set_skip_breakpoints', [true]);
      if (this.options.ignoreErrorBreaks) this.send('set_ignore_error_breaks', [true]);
    }

    const args = Array.isArray(data) ? data : [];
    if (name === 'error') {
      this.recordError(args);
    } else if (name === 'debug_enter') {
      // Godot before 4.5 cannot be told to ignore error breaks, so answer every break at once
      this.send('continue');
    }
  }

  private send(name: string, data: unknown[] = []) {
    if (!this.socket || this.socket.destroyed) return;
    const body = encodeVariant([name, this.threadId, data]);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([length, body]));
  }

  // An error message is [hour, minute, second, msec, source_file, source_function, source_line,
  // error, error_description, is_warning, stack_size, stack...], with 3 stack entries per frame:
  // file, function, line.
  private recordError(args: Variant[]) {
    const [, , , , sourceFile, sourceFunction, sourceLine, error, description, warning, stackSize] = args;
    const stackValues = args.slice(11, 11 + Number(stackSize ?? 0));
    const stack: Array<{ file: string; line: number; function: string }> = [];
    for (let i = 0; i + 2 < stackValues.length; i += 3) {
      stack.push({ file: String(stackValues[i]), function: String(stackValues[i + 1]), line: Number(stackValues[i + 2]) });
    }
    const location = stack[0] ?? { file: String(sourceFile), function: String(sourceFunction), line: Number(sourceLine) };
    const message = String(description || error);
    const isWarning = warning === true;
    const now = Date.now() - this.startedAt;

    const key = JSON.stringify([isWarning, message, location.file, location.line]);
    const existing = this.errors.get(key);
    if (existing) {
      existing.count++;
      existing.lastSeenMs = now;
      return;
    }
    if (this.errors.size >= MAX_REPORTED_ERRORS) {
      this.droppedErrorReports++;
      return;
    }
    this.errors.set(key, {
      message,
      ...(description && error && description !== error ? { condition: String(error) } : {}),
      warning: isWarning,
      ...location,
      ...(stack.length > 1 ? { stack } : {}),
      count: 1,
      firstSeenMs: now,
      lastSeenMs: now,
    });
  }
}
