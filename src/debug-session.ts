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

  private waiters: Array<{ names: string[]; resolve: (message: { name: string; data: Variant[] }) => void }> = [];
  // From the last scene tree the game sent
  private nodesByPath = new Map<string, RemoteNode>();
  private pathsById = new Map<string, string>();

  constructor(
    private options: {
      ignoreErrorBreaks: boolean;
      /** Godot 4.5+ has inspect_objects; earlier versions only the single-object inspect_object */
      inspectObjects: boolean;
      log?: (message: string) => void;
    }
  ) {}

  get isConnected(): boolean {
    return this.connected && !!this.socket && !this.socket.destroyed;
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
    const waiter = this.waiters.find((candidate) => candidate.names.includes(name));
    if (waiter) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve({ name, data: args });
    }
    if (name === 'error') {
      this.recordError(args);
    } else if (name === 'debug_enter') {
      // Godot before 4.5 cannot be told to ignore error breaks, so answer every break at once
      this.send('continue');
    }
  }

  /**
   * The live scene tree, rooted at the Window /root. Also refreshes the path cache used by findNode.
   */
  async sceneTree(): Promise<RemoteNode> {
    const { data } = await this.request('scene:request_scene_tree', [], ['scene:scene_tree']);
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
      const reply = await this.request('scene:inspect_objects', [[BigInt(id)], false], ['scene:inspect_objects', 'remote_nothing_selected', 'remote_objects_selected']);
      if (reply.name !== 'scene:inspect_objects' || !Array.isArray(reply.data[0])) return null;
      object = reply.data[0];
    } else {
      const reply = await this.request('scene:inspect_object', [BigInt(id)], ['scene:inspect_object']);
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
   * Send a message and resolve with the first later message named one of `replyNames`.
   */
  private request(name: string, data: unknown[], replyNames: string[]): Promise<{ name: string; data: Variant[] }> {
    if (!this.isConnected) return Promise.reject(new Error('The game is not connected to the debugger'));
    return new Promise((resolve, reject) => {
      const waiter = {
        names: replyNames,
        resolve: (message: { name: string; data: Variant[] }) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`The game did not answer ${name} within ${REQUEST_TIMEOUT_MS / 1000} s`));
      }, REQUEST_TIMEOUT_MS);
      this.waiters.push(waiter);
      this.send(name, data);
    });
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
