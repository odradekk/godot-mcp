/**
 * The server's side of Godot's remote debugger protocol for one game run.
 *
 * The game connects to a TCP port the session listens on and exchanges length-prefixed Variant
 * messages `[name, thread_id, data]`. The session keeps the game from ever pausing, and collects
 * the errors and warnings the game reports, merging repeats.
 */

import net from 'net';

import { variantToJson } from './runtime-values.js';
import { Variant, decodeVariant, encodeVariant } from './variant.js';

// Distinct errors kept per run; later reports are counted but not stored
const MAX_REPORTED_ERRORS = 200;
const REQUEST_TIMEOUT_MS = 3000;

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

/** A node of the running game's scene tree */
export interface RemoteNode {
  name: string;
  /** Absolute path, e.g. /root/Main/Player */
  path: string;
  /** The script's class_name, else the script's path for a scripted node, else the engine class */
  typeName: string;
  id: number | bigint;
  /** The scene file the node was instanced from, if any */
  sceneFile: string;
  children: RemoteNode[];
}

/** One entry of an inspected object's property list */
export interface RemoteProperty {
  name: string;
  type: number;
  hint: number;
  hintString: string;
  usage: number;
  value: Variant;
}

export interface InspectedObject {
  className: string;
  properties: RemoteProperty[];
}

export interface Breakpoint {
  /** res:// path */
  file: string;
  line: number;
}

export interface StackFrame {
  file: string;
  line: number;
  function: string;
}

export type ResumeAction = 'continue' | 'step' | 'next' | 'out';

/** Where and why the game is paused, captured when it paused */
export interface PauseState {
  /** breakpoint, breakpoint statement, step, pause (pause_game) or error */
  reason: string;
  /** The error text, for reason "error" */
  error?: string;
  /** Innermost frame first; empty when the game paused outside script code */
  stack: StackFrame[];
  /** Stack frame the variables belong to */
  frame: number;
  variables: { locals: Record<string, unknown>; members: Record<string, unknown> } | null;
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

  // Godot's replies carry no request id, so requests go out one at a time: `queue` settles when the
  // last queued request has, and `pending` receives every message while a request is in flight
  private queue: Promise<void> = Promise.resolve();
  private pending: { receive(name: string, data: Variant[]): void; fail(error: Error): void } | null = null;
  // From the last scene tree the game sent
  private nodesByPath = new Map<string, RemoteNode>();
  private pathsById = new Map<string, string>();

  constructor(
    private options: {
      /** Godot 4.5+ has set_ignore_error_breaks; earlier versions break on every error */
      ignoreErrorBreaks: boolean;
      /** Godot 4.5+ has inspect_objects; earlier versions only the single-object inspect_object */
      inspectObjects: boolean;
      /** Pause on script errors instead of letting the game run through them */
      breakOnError: boolean;
      /** Breakpoints to set when the game connects */
      breakpoints: Breakpoint[];
      log?: (message: string) => void;
    }
  ) {
    for (const breakpoint of options.breakpoints) this.breakpoints.set(breakpointKey(breakpoint), breakpoint);
  }

  private breakpoints = new Map<string, Breakpoint>();
  // Pausing and stepping stop through the breakpoint path, which set_skip_breakpoints also skips,
  // so breakpoints are skipped only while none are set and the agent is not pausing or stepping
  private debugging = false;
  // Thread that sent the current debug_enter, or null while running
  private pausedThread: number | bigint | null = null;
  // Counts pauses, so a waiter can ask for one that started after it began waiting
  private pauseCount = 0;
  private pauseState: PauseState | null = null;
  private lastAction: ResumeAction | 'pause' | null = null;
  private pauseWaiters: Array<() => void> = [];
  // The game connected and the connection has since closed
  private disconnected = false;

  get isConnected(): boolean {
    return this.connected && !this.closed && !!this.socket && !this.socket.destroyed;
  }

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
   * before exiting are still read. A request in flight fails.
   */
  close() {
    this.closed = true;
    this.server?.close();
    this.socket?.end();
    this.pending?.fail(new Error('The debug session was closed'));
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
    // A closed connection resumes a paused game (Godot leaves its break loop)
    socket.on('close', () => {
      this.disconnected = true;
      this.pending?.fail(new Error('The game disconnected from the debugger'));
      this.pausedThread = null;
      this.pauseState = null;
      this.notifyPauseWaiters();
    });
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
      // Skip breakpoint statements unless the agent set breakpoints, and, where Godot allows it,
      // do not break on errors unless asked to
      this.updateSkipBreakpoints();
      for (const { file, line } of this.breakpoints.values()) this.send('breakpoint', [file, line, true]);
      if (this.options.ignoreErrorBreaks) this.send('set_ignore_error_breaks', [!this.options.breakOnError]);
    }

    const args = Array.isArray(data) ? data : [];
    this.pending?.receive(name, args);
    if (name === 'error') {
      this.recordError(args);
    } else if (name === 'debug_enter') {
      this.enterPause(args);
    } else if (name === 'debug_exit') {
      this.pausedThread = null;
      this.pauseState = null;
    }
  }

  // debug_enter is [can_continue, error_text, has_stack, thread_id]
  private enterPause(args: Variant[]) {
    const [, text, , threadId] = args;
    const errorText = String(text ?? '');
    const isError = !['', 'Breakpoint', 'Breakpoint Statement'].includes(errorText);
    const thread = typeof threadId === 'number' || typeof threadId === 'bigint' ? threadId : this.threadId;
    if (isError && !this.options.breakOnError) {
      // Only Godot before 4.5 breaks here: it cannot be told to ignore error breaks
      this.send('continue', [], thread);
      return;
    }

    const reason = isError ? 'error'
      : errorText === 'Breakpoint Statement' ? 'breakpoint statement'
        : errorText === '' ? 'pause'
          : this.lastAction === 'step' || this.lastAction === 'next' || this.lastAction === 'out' ? 'step'
            : 'breakpoint';
    this.pausedThread = thread;
    this.pauseState = null;
    const pause = ++this.pauseCount;
    this.capturePause(pause, reason, isError ? errorText : undefined);
  }

  private async capturePause(pause: number, reason: string, error?: string) {
    let stack: StackFrame[] = [];
    let variables: PauseState['variables'] = null;
    try {
      stack = await this.stackDump();
      if (stack.length > 0) variables = await this.frameVariables(0);
    } catch (failure) {
      this.options.log?.(`Could not read the paused game's state: ${failure instanceof Error ? failure.message : failure}`);
    }
    // The game may have resumed while the state was being read
    if (pause !== this.pauseCount || this.pausedThread === null) return;
    this.pauseState = { reason, ...(error ? { error } : {}), stack, frame: 0, variables };
    this.notifyPauseWaiters();
  }

  /** The current pause, once its state has been read; null while running */
  get pause(): PauseState | null {
    return this.pausedThread === null ? null : this.pauseState;
  }

  get isPaused(): boolean {
    return this.pausedThread !== null;
  }

  /**
   * Wait up to `timeoutMs` for a pause (with its state read) that began after `afterPause`
   * (a value of pauseNumber), including while the game has yet to connect. Resolves with null on
   * timeout or when the connection closes.
   */
  waitForPause(afterPause: number, timeoutMs: number): Promise<PauseState | null> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.pauseCount > afterPause && this.pause) return finish(this.pause);
        if (this.disconnected) return finish(null);
        return false;
      };
      const finish = (result: PauseState | null) => {
        clearTimeout(timer);
        this.pauseWaiters = this.pauseWaiters.filter((waiter) => waiter !== check);
        resolve(result);
        return true;
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      if (!check()) this.pauseWaiters.push(check);
    });
  }

  /** Increases with every pause; pass to waitForPause to wait for the next one */
  get pauseNumber(): number {
    return this.pauseCount;
  }

  private notifyPauseWaiters() {
    for (const check of [...this.pauseWaiters]) check();
  }

  /** Set or clear a breakpoint in the running game (and in later connections of this session) */
  setBreakpoint(breakpoint: Breakpoint, enabled: boolean) {
    if (enabled) this.breakpoints.set(breakpointKey(breakpoint), breakpoint);
    else this.breakpoints.delete(breakpointKey(breakpoint));
    if (!this.isConnected) return;
    this.send('breakpoint', [breakpoint.file, breakpoint.line, enabled]);
    this.updateSkipBreakpoints();
  }

  /** Ask the running game to pause; its state arrives with the pause (see waitForPause) */
  pauseGame() {
    this.debugging = true;
    this.lastAction = 'pause';
    this.updateSkipBreakpoints();
    this.send('break');
  }

  /** Continue or step the paused game */
  resume(action: ResumeAction) {
    const thread = this.pausedThread;
    this.debugging = action !== 'continue';
    this.lastAction = action;
    this.updateSkipBreakpoints();
    this.send(action, [], thread ?? undefined);
  }

  /** Locals and members of a frame of the paused game */
  async frameVariables(frame: number): Promise<{ locals: Record<string, unknown>; members: Record<string, unknown> }> {
    // stack_frame_vars gives the count, then one stack_frame_var arrives per variable
    let expected: number | null = null;
    const vars: Variant[][] = [];
    await this.request('get_stack_frame_vars', [frame], (name, data) => {
      if (name === 'stack_frame_vars') expected = Number(data[0]);
      else if (name === 'stack_frame_var') vars.push(data);
      return vars.length === expected ? vars : undefined;
    }, this.pausedThread ?? undefined);

    // Each variable is [name, scope (0 local, 1 member, 2 global), type, value, type_hint]
    const locals: Record<string, unknown> = {};
    const members: Record<string, unknown> = {};
    for (const [name, scope, type, value] of vars) {
      if (name === 'self' || Number(scope) > 1) continue;
      (Number(scope) === 0 ? locals : members)[String(name)] = variantToJson(value, this.nodePathOf, Number(type));
    }
    return { locals, members };
  }

  /**
   * Evaluate an expression in a frame of the paused game (Godot 4.4+). Godot returns null when the
   * expression fails, and does not answer at all outside a script instance's frame.
   */
  async evaluate(expression: string, frame: number): Promise<unknown> {
    const { data } = await this.request('evaluate', [expression, frame], replyNamed('evaluation_return'), this.pausedThread ?? undefined);
    // [expression, scope, type, value, type_hint]
    return variantToJson(data[3], this.nodePathOf, Number(data[2]));
  }

  private async stackDump(): Promise<StackFrame[]> {
    const { data } = await this.request('get_stack_dump', [], replyNamed('stack_dump'), this.pausedThread ?? undefined);
    // [frame_count * 3, file, line, function, ...]
    const frames: StackFrame[] = [];
    for (let at = 1; at + 2 < data.length && at < Number(data[0]); at += 3) {
      frames.push({ file: String(data[at]), line: Number(data[at + 1]), function: String(data[at + 2]) });
    }
    return frames;
  }

  private updateSkipBreakpoints() {
    this.send('set_skip_breakpoints', [this.breakpoints.size === 0 && !this.debugging]);
  }

  /**
   * The live scene tree, rooted at the Window /root. Also refreshes the path cache used by findNode.
   */
  async sceneTree(): Promise<RemoteNode> {
    const { data } = await this.request('scene:request_scene_tree', [], replyNamed('scene:scene_tree'));
    // Nodes arrive in pre-order as [child_count, name, type_name, id, scene_file_path, view_flags]
    let index = 0;
    const readNode = (parentPath: string): RemoteNode => {
      const [childCount, name, typeName, id, sceneFile] = data.slice(index, index + 6);
      index += 6;
      const path = `${parentPath}/${String(name)}`;
      const node: RemoteNode = { name: String(name), path, typeName: String(typeName), id: id as number | bigint, sceneFile: String(sceneFile), children: [] };
      for (let i = 0; i < Number(childCount); i++) node.children.push(readNode(path));
      return node;
    };
    const root = readNode('');

    this.nodesByPath.clear();
    this.pathsById.clear();
    const remember = (node: RemoteNode) => {
      this.nodesByPath.set(node.path, node);
      this.pathsById.set(String(node.id), node.path);
      node.children.forEach(remember);
    };
    remember(root);
    return root;
  }

  /**
   * The node at an absolute path, refreshing the tree once if the cached tree does not have it.
   * Returns null if the node does not exist.
   */
  async findNode(path: string): Promise<RemoteNode | null> {
    if (!this.nodesByPath.has(path)) await this.sceneTree();
    return this.nodesByPath.get(path) ?? null;
  }

  /** Paths in the last tree that share the most leading segments with `path` */
  nearestPaths(path: string, limit = 5): string[] {
    const segments = path.split('/');
    const shared = (candidate: string) => {
      const other = candidate.split('/');
      let count = 0;
      while (count < segments.length && count < other.length && segments[count] === other[count]) count++;
      return count;
    };
    return [...this.nodesByPath.keys()]
      .map((candidate) => ({ candidate, score: shared(candidate) }))
      .sort((a, b) => b.score - a.score || a.candidate.length - b.candidate.length)
      .slice(0, limit)
      .map(({ candidate }) => candidate);
  }

  /** The node path for an object ID from the last tree, if the object is a node */
  nodePathOf = (objectId: bigint): string | undefined => this.pathsById.get(String(objectId));

  /**
   * Every property of an object in the game, or null if the object no longer exists.
   */
  async inspect(id: number | bigint): Promise<InspectedObject | null> {
    let object: Variant[];
    if (this.options.inspectObjects) {
      // A missing object is answered with remote_nothing_selected instead
      const reply = await this.request('scene:inspect_objects', [[BigInt(id)], false], replyNamed('scene:inspect_objects', 'remote_nothing_selected', 'remote_objects_selected'));
      if (reply.name !== 'scene:inspect_objects' || !Array.isArray(reply.data[0])) return null;
      object = reply.data[0];
    } else {
      const reply = await this.request('scene:inspect_object', [BigInt(id)], replyNamed('scene:inspect_object'));
      if (reply.data.length < 3) return null;
      object = reply.data;
    }
    const [, className, properties] = object;
    return {
      className: String(className),
      properties: (properties as Variant[][]).map(([name, type, hint, hintString, usage, value]) => ({
        name: String(name),
        type: Number(type),
        hint: Number(hint),
        hintString: String(hintString),
        usage: Number(usage),
        value,
      })),
    };
  }

  /** Set a property of an object in the game. Godot does not reply; inspect to read it back. */
  setProperty(id: number | bigint, property: string, value: unknown) {
    this.send('scene:set_object_property', [BigInt(id), property, value]);
  }

  /**
   * Send a message once the requests before it have settled, and resolve with the first result
   * other than undefined that `collect` returns for the messages received meanwhile. Rejects after
   * REQUEST_TIMEOUT_MS, or when the connection ends.
   */
  private request<T>(
    name: string,
    data: unknown[],
    collect: (name: string, data: Variant[]) => T | undefined,
    threadId?: number | bigint
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue = this.queue.then(() => this.exchange(name, data, collect, threadId, resolve, reject));
    });
  }

  /**
   * Run one request. Settles once the request is answered, abandoned or failed, so the next one
   * can go out; never rejects.
   */
  private exchange<T>(
    name: string,
    data: unknown[],
    collect: (name: string, data: Variant[]) => T | undefined,
    threadId: number | bigint | undefined,
    resolve: (result: T) => void,
    reject: (error: Error) => void
  ): Promise<void> {
    if (!this.isConnected) {
      reject(new Error('The game is not connected to the debugger'));
      return Promise.resolve();
    }
    return new Promise((settle) => {
      const timeout = setTimeout(
        () => reject(new Error(`The game did not answer ${name} within ${REQUEST_TIMEOUT_MS / 1000} s`)),
        REQUEST_TIMEOUT_MS
      );
      // Godot answers in order, so a late reply still belongs to this request: keep receiving, and
      // keep the next request back, for one more timeout. A later reply can reach the next request.
      const abandon = setTimeout(() => end(), 2 * REQUEST_TIMEOUT_MS);
      const end = () => {
        clearTimeout(timeout);
        clearTimeout(abandon);
        this.pending = null;
        settle();
      };
      this.pending = {
        receive: (replyName, replyData) => {
          const result = collect(replyName, replyData);
          if (result === undefined) return;
          end();
          resolve(result);
        },
        fail: (error) => {
          end();
          reject(error);
        },
      };
      this.send(name, data, threadId);
    });
  }

  private send(name: string, data: unknown[] = [], threadId: number | bigint = this.threadId) {
    if (!this.socket || this.socket.destroyed) return;
    const body = encodeVariant([name, threadId, data]);
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

/** Collects the first message named one of `names` */
function replyNamed(...names: string[]) {
  return (name: string, data: Variant[]) => (names.includes(name) ? { name, data } : undefined);
}

function breakpointKey({ file, line }: Breakpoint): string {
  return `${file}:${line}`;
}
