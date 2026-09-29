// Record remote debugger messages from a real Godot as test fixtures.
// usage: npm run build && GODOT_PATH=/path/to/godot node scripts/record-debugger-fixtures.mjs
// Writes test/fixtures/debugger-<version>.json: raw frames (length prefix included), base64.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeVariant, encodeVariant } from '../build/variant.js';

const godot = process.env.GODOT_PATH;
if (!godot) throw new Error('Set GODOT_PATH to a Godot 4.5+ executable');
const version = execFileSync(godot, ['--version']).toString().trim();

// Line numbers are asserted by the tests; keep them in sync with the fixture's `lines`
const script = [
  'extends Node', //                          1
  '', //                                      2
  'var frames = 0', //                        3
  'func _ready():', //                        4
  '\tpush_error("pushed error")', //          5
  '\tpush_warning("pushed warning")', //      6
  '\tvar x = null', //                        7
  '\tx.foo()', //                             8
  'func _process(_delta):', //                9
  '\tframes += 1', //                         10
  '\tif frames == 4:', //                     11
  '\t\tget_tree().quit(3)', //                12
  '\tvar y = null', //                        13
  '\ty.bar()', //                             14
].join('\n') + '\n';
const lines = { push_error: 5, push_warning: 6, script_error_ready: 8, script_error_process: 14 };

const project = mkdtempSync(join(tmpdir(), 'godot-debugger-fixture-'));
writeFileSync(join(project, 'project.godot'), 'config_version=5\n\n[application]\n\nrun/main_scene="res://main.tscn"\n');
writeFileSync(join(project, 'main.gd'), script);
writeFileSync(join(project, 'main.tscn'), '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n');

// Run the game once against a listener; `onMessage(name, data, frame, send)` sees every message
function record(onMessage) {
  return new Promise((resolve) => {
    let threadId = 0;
    const server = net.createServer((socket) => {
      let pending = Buffer.alloc(0);
      const send = (name, data = []) => {
        const body = encodeVariant([name, threadId, data]);
        const length = Buffer.alloc(4);
        length.writeUInt32LE(body.length);
        socket.write(Buffer.concat([length, body]));
      };
      socket.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
          const frame = pending.subarray(0, 4 + pending.readUInt32LE(0));
          pending = pending.subarray(frame.length);
          const [[name, tid, data]] = decodeVariant(frame, 4);
          if (tid) threadId = tid;
          onMessage(name, data, frame, send);
        }
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const game = spawn(godot, ['--remote-debug', `tcp://127.0.0.1:${server.address().port}`, '--headless', '--path', project], { stdio: 'ignore' });
      game.on('close', () => {
        server.close();
        resolve();
      });
    });
  });
}

const frames = {};
const keep = (key, frame) => {
  frames[key] ??= frame.toString('base64');
};

// Run 1: errors reported while the game is told not to break
await record((name, data, frame, send) => {
  if (name === 'set_pid') {
    keep('set_pid', frame);
    send('set_skip_breakpoints', [true]);
    send('set_ignore_error_breaks', [true]);
  } else if (name === 'error') {
    const text = String(data[7]);
    if (text.includes('pushed error')) keep('push_error', frame);
    else if (text.includes('pushed warning')) keep('push_warning', frame);
    else if (text.includes("'foo'")) keep('script_error_ready', frame);
    else if (text.includes("'bar'")) keep('script_error_process', frame);
  }
});

// Run 2: the break Godot sends on an error when error breaks are not ignored
await record((name, data, frame, send) => {
  if (name === 'debug_enter') {
    keep('debug_enter_error', frame);
    send('continue');
  }
});

rmSync(project, { recursive: true, force: true });
const expected = ['set_pid', 'push_error', 'push_warning', 'script_error_ready', 'script_error_process', 'debug_enter_error'];
const missing = expected.filter((key) => !frames[key]);
if (missing.length) throw new Error(`Did not record: ${missing.join(', ')}`);

const shortVersion = version.split('.').slice(0, 3).join('.');
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', `debugger-${shortVersion}.json`);
writeFileSync(out, JSON.stringify({ godotVersion: version, script: 'res://main.gd', lines, frames }, null, 2) + '\n');
console.log(`Wrote ${out}`);
