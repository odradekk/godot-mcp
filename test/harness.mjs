// Test harness: builds the server from build/ and talks to it through an in-process MCP client.
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { dirname, join, normalize } from 'node:path';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { GodotServer } from '../build/server.js';
import { decodeVariant, encodeVariant } from '../build/variant.js';

export const GODOT_VERSION = '4.7.2.stable.official';

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
 * child.exit(code). kill() exits with code null unless child.ignoreKill is set.
 */
function fakeChild(args) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.args = args;
  child.connectDebugger = () => connectDebugger(args);
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.ignoreKill = false;
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
  child.kill = () => {
    child.killed = true;
    if (!child.ignoreKill) child.exit(null);
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
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
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
 * [name, threadId, data] messages from the server, and `waitFor(name)` resolves with the first
 * one of that name. `answer(name, ...frames)` replies to every later message of that name;
 * `rawReceived` keeps each message's bytes for checking encoded Variant types.
 */
async function connectDebugger(args) {
  const url = new URL(args[args.indexOf('--remote-debug') + 1]);
  const socket = net.connect(Number(url.port), url.hostname);
  await once(socket, 'connect');
  const received = [];
  const rawReceived = [];
  const answers = new Map();
  const waiters = [];
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      const length = pending.readUInt32LE(0);
      const [message] = decodeVariant(pending, 4);
      rawReceived.push(Buffer.from(pending.subarray(4, 4 + length)));
      pending = pending.subarray(4 + length);
      received.push(message);
      for (const frame of answers.get(message[0]) ?? []) socket.write(frame);
      for (const waiter of [...waiters]) waiter();
    }
  });
  return {
    received,
    rawReceived,
    answer: (name, ...frames) => answers.set(name, frames),
    send: (frame) => socket.write(frame),
    waitFor: (name, timeoutMs = 2000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const message = received.find(([messageName]) => messageName === name);
          if (!message) return false;
          waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          resolve(message);
          return true;
        };
        const timer = setTimeout(() => reject(new Error(`the server sent no ${name}`)), timeoutMs);
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

/** A length-prefixed frame for a message the game would send */
export function debuggerFrame(name, threadId, data) {
  const body = encodeVariant([name, threadId, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
}
