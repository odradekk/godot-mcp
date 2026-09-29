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

// Run a project's game once against a listener; `onMessage(name, data, frame, send, game)` sees
// every message. The run ends when the game exits (or is killed by onMessage).
function record(projectDir, onMessage) {
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
          onMessage(name, data, frame, send, game);
        }
      });
      socket.on('error', () => {});
    });
    let game;
    server.listen(0, '127.0.0.1', () => {
      game = spawn(godot, ['--remote-debug', `tcp://127.0.0.1:${server.address().port}`, '--headless', '--path', projectDir], { stdio: 'ignore' });
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
await record(project, (name, data, frame, send) => {
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
await record(project, (name, data, frame, send) => {
  if (name === 'debug_enter') {
    keep('debug_enter_error', frame);
    send('continue');
  }
});

// Run 3: scene tree and property replies from a scene with an autoload, a scripted node, a
// resource-valued property and a Control
const inspection = mkdtempSync(join(tmpdir(), 'godot-debugger-fixture-'));
writeFileSync(join(inspection, 'project.godot'), 'config_version=5\n\n[application]\n\nrun/main_scene="res://main.tscn"\n\n[autoload]\n\nGameState="*res://game_state.gd"\n');
writeFileSync(join(inspection, 'game_state.gd'), 'extends Node\n\nvar level = 3\n');
writeFileSync(join(inspection, 'main.gd'), 'extends Node\n');
writeFileSync(join(inspection, 'player.gd'), [
  'extends Node2D',
  '',
  'const MAX_SPEED = 500',
  '@export var speed = 120.0',
  'var velocity = Vector2(1, 2)',
  'var tint = Color(1, 0, 0)',
  'var target: Node = null',
  '',
  'func _ready():',
  '\ttarget = get_parent()',
].join('\n') + '\n');
writeFileSync(join(inspection, 'gradient.tres'), '[gd_resource type="GradientTexture2D" format=3]\n\n[resource]\n');
writeFileSync(join(inspection, 'main.tscn'), [
  '[gd_scene load_steps=4 format=3]',
  '',
  '[ext_resource type="Script" path="res://main.gd" id="1"]',
  '[ext_resource type="Script" path="res://player.gd" id="2"]',
  '[ext_resource type="Texture2D" path="res://gradient.tres" id="3"]',
  '',
  '[node name="Main" type="Node"]',
  'script = ExtResource("1")',
  '',
  '[node name="Player" type="Node2D" parent="."]',
  'position = Vector2(10, 20)',
  'script = ExtResource("2")',
  '',
  '[node name="Sprite" type="Sprite2D" parent="Player"]',
  'texture = ExtResource("3")',
  '',
  '[node name="HUD" type="CanvasLayer" parent="."]',
  '',
  '[node name="Label" type="Label" parent="HUD"]',
  'text = "hi"',
].join('\n') + '\n');

await record(inspection, (name, data, frame, send, game) => {
  if (name === 'set_pid') {
    send('set_skip_breakpoints', [true]);
    setTimeout(() => send('scene:request_scene_tree'), 500);
  } else if (name === 'scene:scene_tree') {
    keep('scene_tree', frame);
    const idOf = (nodeName) => data[data.indexOf(nodeName) + 2];
    send('scene:inspect_objects', [[idOf('Player')], false]);
    send('scene:inspect_objects', [[idOf('Sprite')], false]);
    send('scene:inspect_object', [idOf('Player')]);
    send('scene:inspect_objects', [[1], false]);
  } else if (name === 'scene:inspect_objects') {
    keep(data[0][1] === 'Sprite2D' ? 'inspect_sprite' : 'inspect_player', frame);
  } else if (name === 'scene:inspect_object') {
    keep('inspect_object_player', frame);
  } else if (name === 'remote_nothing_selected') {
    keep('inspect_missing', frame);
    game.kill();
  }
});

rmSync(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
rmSync(inspection, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
const expected = ['set_pid', 'push_error', 'push_warning', 'script_error_ready', 'script_error_process', 'debug_enter_error',
  'scene_tree', 'inspect_player', 'inspect_sprite', 'inspect_object_player', 'inspect_missing'];
const missing = expected.filter((key) => !frames[key]);
if (missing.length) throw new Error(`Did not record: ${missing.join(', ')}`);

const shortVersion = version.split('.').slice(0, 3).join('.');
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', `debugger-${shortVersion}.json`);
writeFileSync(out, JSON.stringify({ godotVersion: version, script: 'res://main.gd', lines, frames }, null, 2) + '\n');
console.log(`Wrote ${out}`);
