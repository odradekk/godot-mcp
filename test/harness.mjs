// Test harness: builds the server from build/ and talks to it through an in-process MCP client.
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { dirname, join, normalize } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { FrameReader, encodeFrame } from '../build/debugger-frames.js';
import { GodotServer } from '../build/server.js';
import { decodeVariant } from '../build/variant.js';

export const GODOT_VERSION = '4.7.2.stable.official';
export const GODOT = '/opt/godot';
export const THREAD_ID = 1; // main thread ID in the recorded frames

/** A frame for a message the game would send */
export { encodeFrame as debuggerFrame };

/**
 * A Godot launcher that records every call in `calls`. `respond(file, args)` returns
 * `{ stdout, stderr, exitCode }` (all optional) or throws to simulate a process that cannot start.
 */
export function fakeLauncher(respond) {
  const calls = [];
  const children = [];
  return {
    calls,
    children,
    async run(file, args, options) {
      calls.push({ file, args, options });
      return { stdout: '', stderr: '', exitCode: 0, ...(await respond(file, args)) };
    },
    start(file, args, options) {
      calls.push({ file, args, options });
      const child = fakeChild(args);
      children.push(child);
      return child;
    },
  };
}

/**
 * A child process driven by the test: write to child.stdout and child.stderr, and end it with
 * child.exit(code). kill(signal) records the signal in child.signals and exits with code null,
 * unless the signal is in child.ignoredSignals.
 */
function fakeChild(args) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.args = args;
  child.connectDebugger = () => connectDebugger(args);
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.ignoredSignals = [];
  child.exit = (code) => {
    // Like a real process, 'close' follows once both streams have been read to the end
    let open = 2;
    const ended = () => {
      if (--open === 0) child.emit('close', code);
    };
    child.stdout.on('end', ended);
    child.stderr.on('end', ended);
    child.stdout.end();
    child.stderr.end();
  };
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    child.signals.push(signal);
    if (!child.ignoredSignals.includes(signal)) child.exit(null);
    return true;
  };
  return child;
}

/**
 * Responder for a machine where Godot is installed only at `paths`. Those binaries answer
 * `--version`; any other file fails to start, like a missing executable.
 */
export function godotAt(...paths) {
  const installed = new Set(paths.map((path) => normalize(path)));
  return (file, args) => {
    if (!installed.has(file)) {
      throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
    }
    if (args[0] === '--version') return { stdout: `${GODOT_VERSION}\n` };
    throw new Error(`Unexpected Godot call: ${args.join(' ')}`);
  };
}

/** Responder for Godot that reports `version`; any other call fails the test */
export function godotReporting(version) {
  return (file, args) => {
    if (args[0] === '--version') return { stdout: `${version}\n` };
    throw new Error(`Unexpected Godot call: ${args.join(' ')}`);
  };
}

/**
 * Construct a server and connect an MCP client to it. `env` defaults to empty so the
 * developer's own GODOT_PATH or DEBUG never leaks into a test.
 */
export async function connect(config = {}) {
  const server = new GodotServer({ env: {}, ...config });
  const client = new Client({ name: 'godot-mcp-test', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  let closed = false;
  return {
    client,
    // Tests register it with t.after and some also call it themselves, so a second call does nothing
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
      await server.close();
    },
  };
}

/**
 * Poll the async `check` until it returns a truthy value and return that value. After timeoutMs
 * it returns the last (falsy) value instead of throwing, so the caller's assertion reports what
 * it saw.
 */
export async function pollUntil(check, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value || Date.now() >= deadline) return value;
    await sleep(intervalMs);
  }
}

/** Concatenated text content of a tool result. */
export function text(result) {
  return result.content.map((item) => item.text).join('\n');
}

/**
 * Create a temporary Godot project containing `files` (path relative to the project -> content),
 * removed when the test ends.
 */
export async function makeProject(t, files = {}) {
  const projectPath = await mkdtemp(join(tmpdir(), 'godot-mcp-test-'));
  // Windows keeps a killed Godot's handles on the project for a moment
  t.after(() => rm(projectPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const all = { 'project.godot': 'config_version=5\n', ...files };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(dirname(join(projectPath, path)), { recursive: true });
    await writeFile(join(projectPath, path), content);
  }
  return projectPath;
}

/**
 * Connect to the debug port in a game's --remote-debug argument, as the real game does.
 * `send(frame)` writes raw frames (see debuggerFixtures); `received` holds the decoded
 * [name, threadId, data] messages from the server, and `waitFor(name, { count })` resolves with the
 * count-th one of that name (the first by default). `answer(name, ...frames)` replies to every
 * later message of that name; a function among the frames is called with the message's data and
 * returns the frames to send. `rawReceived` keeps each message's bytes for checking encoded Variant types.
 */
async function connectDebugger(args) {
  const url = new URL(args[args.indexOf('--remote-debug') + 1]);
  const socket = net.connect(Number(url.port), url.hostname);
  await once(socket, 'connect');
  const received = [];
  const rawReceived = [];
  const answers = new Map();
  const waiters = [];
  const reader = new FrameReader();
  socket.on('data', (chunk) => {
    for (const frame of reader.push(chunk)) {
      const [message] = decodeVariant(frame, 4);
      rawReceived.push(frame.subarray(4));
      received.push(message);
      const replies = (answers.get(message[0]) ?? []).flatMap((reply) => (typeof reply === 'function' ? reply(message[2]) : [reply]));
      for (const frame of replies) socket.write(frame);
      for (const waiter of [...waiters]) waiter();
    }
  });
  return {
    received,
    rawReceived,
    answer: (name, ...frames) => answers.set(name, frames),
    send: (frame) => socket.write(frame),
    waitFor: (name, { count = 1, timeoutMs = 2000 } = {}) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const messages = received.filter(([messageName]) => messageName === name);
          if (messages.length < count) return false;
          waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          resolve(messages[count - 1]);
          return true;
        };
        const timer = setTimeout(() => reject(new Error(`the server sent no ${name} #${count}`)), timeoutMs);
        waiters.push(check);
        check();
      }),
    close: () => socket.destroy(),
  };
}

/**
 * Remote debugger frames recorded from a real Godot by scripts/record-debugger-fixtures.mjs,
 * as Buffers, with the script lines they point at.
 */
export function debuggerFixtures(version = '4.7.2') {
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/debugger-${version}.json`, import.meta.url), 'utf8'));
  const frames = Object.fromEntries(Object.entries(fixture.frames).map(([key, base64]) => [key, Buffer.from(base64, 'base64')]));
  return { ...fixture, frames };
}

/**
 * Start a game through run_project on a fake launcher whose Godot reports `version`. `before(call)`
 * runs first, for tool calls that must precede the run. `json` parses the tool's own reply, the
 * last content item, which may follow a pause note.
 */
export async function startGame(t, { version = GODOT_VERSION, config = {}, runArgs = {}, before } = {}) {
  const launcher = fakeLauncher(godotReporting(version));
  const { client, close } = await connect({ godotPath: GODOT, launcher, ...config });
  t.after(close);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const json = async (name, args) => JSON.parse((await call(name, args)).content.at(-1).text);
  await before?.(call);
  const projectPath = await makeProject(t);
  await call('run_project', { projectPath, ...runArgs });
  return { client, launcher, game: launcher.children.at(-1), call, json, projectPath };
}

/** Connect a game's debugger and complete the handshake, so the server has started talking to it */
export async function attach(game) {
  const debug = await game.connectDebugger();
  debug.send(debuggerFixtures().frames.set_pid);
  await debug.waitFor('set_skip_breakpoints');
  return debug;
}
