// Test harness: builds the server from build/ and talks to it through an in-process MCP client.
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { GodotServer } from '../build/server.js';

export const GODOT_VERSION = '4.7.2.stable.official';

/**
 * A Godot launcher that records every call in `calls`. `respond(file, args)` returns
 * `{ stdout, stderr, exitCode }` (all optional) or throws to simulate a process that cannot start.
 */
export function fakeLauncher(respond) {
  const calls = [];
  return {
    calls,
    async run(file, args, options) {
      calls.push({ file, args, options });
      return { stdout: '', stderr: '', exitCode: 0, ...(await respond(file, args)) };
    },
    start(file, args) {
      calls.push({ file, args });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        child.emit('exit', null);
        return true;
      };
      return child;
    },
  };
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
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  const all = { 'project.godot': 'config_version=5\n', ...files };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(dirname(join(projectPath, path)), { recursive: true });
    await writeFile(join(projectPath, path), content);
  }
  return projectPath;
}
