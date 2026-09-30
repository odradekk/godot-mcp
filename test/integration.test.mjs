// Runs against a real Godot binary. Skipped unless GODOT_PATH is set.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { connect, makeProject, pollUntil, text } from './harness.mjs';

const godotPath = process.env.GODOT_PATH;
// CI installs Godot, so a missing one must fail the run there instead of skipping these tests
const skip = !godotPath && !process.env.CI && 'GODOT_PATH is not set';

async function realGodot(t) {
  const { client, close } = await connect({ godotPath, strictPathValidation: true });
  t.after(close);
  return client;
}

async function call(client, name, args) {
  return client.callTool({ name, arguments: args });
}

// Poll get_debug_output until the game exits, for up to 20 s
async function waitForRunEnd(client) {
  let run;
  await pollUntil(async () => !(run = JSON.parse(text(await call(client, 'get_debug_output', {})))).running, { timeoutMs: 20000, intervalMs: 200 });
  return run;
}

// A project whose main scene runs `script`
function gameProject(t, script) {
  return makeProject(t, {
    'project.godot': 'config_version=5\n\n[application]\n\nrun/main_scene="res://main.tscn"\n',
    'main.gd': script,
    'main.tscn': '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n',
  });
}

test('real Godot: version and project info', { skip }, async (t) => {
  const client = await realGodot(t);
  const projectPath = await makeProject(t, { 'project.godot': 'config_version=5\n\n[application]\n\nconfig/name="Integration Demo"\n' });

  const version = await call(client, 'get_godot_version', {});
  const info = await call(client, 'get_project_info', { projectPath });

  assert.equal(version.isError, undefined);
  assert.match(text(version), /^\d+\.\d+/);
  assert.equal(info.isError, undefined);
  const project = JSON.parse(text(info));
  assert.equal(project.name, 'Integration Demo');
  assert.equal(project.godotVersion, text(version));
});

test('real Godot: scene operations report results and failures', { skip }, async (t) => {
  const client = await realGodot(t);
  const projectPath = await makeProject(t, {
    'box.tres': '[gd_resource type="BoxMesh" format=3]\n\n[resource]\n',
    'gradient.tres': '[gd_resource type="GradientTexture2D" format=3]\n\n[resource]\n',
  });

  const created = await call(client, 'create_scene', { projectPath, scenePath: 'scenes/main.tscn' });
  assert.equal(text(created), 'Scene created successfully at: res://scenes/main.tscn');
  const files = await readdir(projectPath, { recursive: true });
  assert.deepEqual(files.filter((file) => file.endsWith('.tmp')), []);

  const badRoot = await call(client, 'create_scene', { projectPath, scenePath: 'bad.tscn', rootNodeType: 'NotAType' });
  assert.equal(badRoot.isError, true);
  assert.match(badRoot.content[0].text, /^Failed to create scene: Failed to instantiate node of type: NotAType\./);

  const abstractRoot = await call(client, 'create_scene', { projectPath, scenePath: 'abstract.tscn', rootNodeType: 'CanvasItem' });
  assert.equal(
    abstractRoot.content[0].text,
    'Failed to create scene: Failed to instantiate node of type: CanvasItem. It is an abstract class that cannot be instantiated.'
  );

  const added = await call(client, 'add_node', {
    projectPath, scenePath: 'scenes/main.tscn', nodeType: 'Sprite2D', nodeName: 'Hero', properties: { position: { x: 3, y: 4 } },
  });
  assert.equal(added.isError, undefined, text(added));
  assert.match(text(added), /added successfully at root\/Hero in 'res:\/\/scenes\/main.tscn'/);

  const badNode = await call(client, 'add_node', { projectPath, scenePath: 'scenes/main.tscn', nodeType: 'NotAType', nodeName: 'X' });
  assert.equal(badNode.isError, true);
  assert.match(badNode.content[0].text, /^Failed to add node: Failed to instantiate node of type: NotAType\./);

  const sprite = await call(client, 'load_sprite', { projectPath, scenePath: 'scenes/main.tscn', nodePath: 'root/Hero', texturePath: 'gradient.tres' });
  assert.equal(sprite.isError, undefined, text(sprite));
  assert.match(text(sprite), /on root\/Hero/);

  const missingNode = await call(client, 'load_sprite', { projectPath, scenePath: 'scenes/main.tscn', nodePath: 'root/Missing', texturePath: 'gradient.tres' });
  assert.equal(missingNode.isError, true);
  assert.equal(missingNode.content[0].text, 'Failed to load sprite: Node not found in res://scenes/main.tscn: root/Missing');

  const saved = await call(client, 'save_scene', { projectPath, scenePath: 'scenes/main.tscn', newPath: 'copies/main_copy.tscn' });
  assert.equal(text(saved), 'Scene saved successfully to: res://copies/main_copy.tscn');
  assert.ok(existsSync(join(projectPath, 'copies', 'main_copy.tscn')));

  await call(client, 'create_scene', { projectPath, scenePath: 'meshes.tscn', rootNodeType: 'Node3D' });
  await call(client, 'add_node', { projectPath, scenePath: 'meshes.tscn', nodeType: 'MeshInstance3D', nodeName: 'Box', properties: { mesh: 'res://box.tres' } });
  const exported = await call(client, 'export_mesh_library', { projectPath, scenePath: 'meshes.tscn', outputPath: 'lib/meshes.tres' });
  assert.equal(text(exported), 'MeshLibrary exported successfully to: res://lib/meshes.tres (1 items: Box)');

  const noMeshes = await call(client, 'export_mesh_library', { projectPath, scenePath: 'scenes/main.tscn', outputPath: 'lib/none.tres' });
  assert.equal(noMeshes.isError, true);
  assert.match(noMeshes.content[0].text, /^Failed to export mesh library: No valid meshes found in the scene/);
});

test('real Godot: add_node loads res:// strings only for properties that take a resource', { skip }, async (t) => {
  const client = await realGodot(t);
  const projectPath = await makeProject(t);
  await call(client, 'create_scene', { projectPath, scenePath: 'main.tscn' });

  const label = await call(client, 'add_node', {
    projectPath, scenePath: 'main.tscn', nodeType: 'Label', nodeName: 'Next', properties: { text: 'res://levels/2.tscn' },
  });
  assert.equal(label.isError, undefined, text(label));
  assert.match(await readFile(join(projectPath, 'main.tscn'), 'utf8'), /text = "res:\/\/levels\/2\.tscn"/);

  const missing = await call(client, 'add_node', {
    projectPath, scenePath: 'main.tscn', nodeType: 'MeshInstance3D', nodeName: 'Box', properties: { mesh: 'res://missing.tres' },
  });
  assert.equal(missing.isError, true);
  assert.equal(missing.content[0].text, 'Failed to add node: Cannot load resource res://missing.tres for property: mesh');
});

test('real Godot: a class_name script can be used once the project has been imported', { skip }, async (t) => {
  const client = await realGodot(t);
  const projectPath = await makeProject(t, { 'thing.gd': 'class_name Thing\nextends Node2D\n' });

  const notImported = await call(client, 'create_scene', { projectPath, scenePath: 'a.tscn', rootNodeType: 'Thing' });
  assert.equal(notImported.isError, true);
  assert.match(notImported.content[0].text, /import the project with update_project_uids/);

  await call(client, 'update_project_uids', { projectPath });
  const imported = await call(client, 'create_scene', { projectPath, scenePath: 'a.tscn', rootNodeType: 'Thing' });
  assert.equal(text(imported), 'Scene created successfully at: res://a.tscn');
});

test('real Godot: an image that has not been imported is reported as such', { skip }, async (t) => {
  const client = await realGodot(t);
  const redPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
  const projectPath = await makeProject(t, { 'art/red.png': redPixel });
  await call(client, 'create_scene', { projectPath, scenePath: 'main.tscn' });
  await call(client, 'add_node', { projectPath, scenePath: 'main.tscn', nodeType: 'Sprite2D', nodeName: 'S' });

  const sprite = await call(client, 'load_sprite', { projectPath, scenePath: 'main.tscn', nodePath: 'root/S', texturePath: 'art/red.png' });
  const property = await call(client, 'add_node', {
    projectPath, scenePath: 'main.tscn', nodeType: 'Sprite2D', nodeName: 'T', properties: { texture: 'res://art/red.png' },
  });

  const note = 'It has not been imported: import the project with update_project_uids (Godot 4.4+) or by opening it in the editor';
  assert.equal(sprite.content[0].text, `Failed to load sprite: Failed to load texture: res://art/red.png. ${note}`);
  assert.equal(property.content[0].text, `Failed to add node: Cannot load resource res://art/red.png for property: texture. ${note}`);
});

test('real Godot: UID tools', { skip }, async (t) => {
  const client = await realGodot(t);
  const projectPath = await makeProject(t, { 'player.gd': 'extends Node\n' });

  const updated = await call(client, 'update_project_uids', { projectPath });
  assert.equal(updated.isError, undefined, text(updated));
  assert.match(text(updated), /^Project UIDs updated successfully\. Resaved 0 scenes; 1 scripts and shaders have UIDs\.$/);

  const uid = await call(client, 'get_uid', { projectPath, filePath: 'player.gd' });
  assert.equal(uid.isError, undefined, text(uid));
  const info = JSON.parse(text(uid));
  assert.equal(info.file, 'res://player.gd');
  assert.equal(info.exists, true);
  assert.match(info.uid, /^uid:\/\//);
});

test('real Godot: node paths follow one rule in every tool', { skip }, async (t) => {
  const client = await realGodot(t);
  const projectPath = await makeProject(t, {
    'gradient.tres': '[gd_resource type="GradientTexture2D" format=3]\n\n[resource]\n',
  });
  const scenePath = 'level.tscn';
  await call(client, 'create_scene', { projectPath, scenePath });
  const add = (parentNodePath, nodeName, nodeType = 'Node2D') =>
    call(client, 'add_node', { projectPath, scenePath, parentNodePath, nodeName, nodeType });

  // Each parent is written a different way; the last one contains "root/" twice
  for (const [parent, name, type, expected] of [
    ['', 'Level', 'Node2D', 'root/Level'],
    ['Level', 'Uproot', 'Node2D', 'root/Level/Uproot'],
    ['root/Level/Uproot', 'Hero', 'Sprite2D', 'root/Level/Uproot/Hero'],
    ['root/Level/Uproot/Hero', 'Weapon', 'Node2D', 'root/Level/Uproot/Hero/Weapon'],
  ]) {
    const result = await add(parent, name, type);
    assert.equal(result.isError, undefined, text(result));
    assert.ok(text(result).includes(`at ${expected} in`), text(result));
  }

  for (const nodePath of ['root/Level/Uproot/Hero', 'Level/Uproot/Hero']) {
    const sprite = await call(client, 'load_sprite', { projectPath, scenePath, nodePath, texturePath: 'gradient.tres' });
    assert.equal(sprite.isError, undefined, text(sprite));
    assert.ok(text(sprite).includes('on root/Level/Uproot/Hero in'), text(sprite));
  }
  await call(client, 'create_scene', { projectPath, scenePath: 'icon.tscn', rootNodeType: 'Sprite2D' });
  const rootSprite = await call(client, 'load_sprite', { projectPath, scenePath: 'icon.tscn', nodePath: 'root', texturePath: 'gradient.tres' });
  assert.equal(rootSprite.isError, undefined, text(rootSprite));

  const saved = await call(client, 'save_scene', { projectPath, scenePath, newPath: 'copies/deep/level.tscn' });
  assert.equal(saved.isError, undefined, text(saved));
  const copy = await readFile(join(projectPath, 'copies', 'deep', 'level.tscn'), 'utf8');
  assert.match(copy, /\[node name="Weapon" type="Node2D" parent="Level\/Uproot\/Hero"[ \]]/);

  const missingParent = await add('root/Nowhere', 'X');
  const missingSprite = await call(client, 'load_sprite', { projectPath, scenePath, nodePath: 'root/Nowhere', texturePath: 'gradient.tres' });
  assert.equal(missingParent.content[0].text, 'Failed to add node: Node not found in res://level.tscn: root/Nowhere');
  assert.equal(missingSprite.content[0].text, 'Failed to load sprite: Node not found in res://level.tscn: root/Nowhere');
  const notAScene = await call(client, 'add_node', { projectPath, scenePath: 'gradient.tres', nodeType: 'Node2D', nodeName: 'X' });
  assert.equal(notAScene.content[0].text, 'Failed to add node: Not a scene file: res://gradient.tres');
});

test('real Godot: run_project captures a game run until it exits', { skip }, async (t) => {
  const client = await realGodot(t);
  const projectPath = await gameProject(
    t,
    'extends Node\n\nfunc _ready():\n\tprint("hello from the game")\n\tprinterr("a game warning")\n\tget_tree().quit(3)\n'
  );

  const started = await call(client, 'run_project', { projectPath });
  assert.equal(started.isError, undefined, text(started));
  const run = await waitForRunEnd(client);

  assert.equal(run.running, false);
  assert.equal(run.exitCode, 3);
  assert.ok(run.output.includes('hello from the game'), run.output.join('\n'));
  assert.ok(run.errors.includes('a game warning'), run.errors.join('\n'));
});

test('real Godot: a script error does not pause the game', { skip }, async (t) => {
  const client = await realGodot(t);
  // _ready fails; the game should keep running and reach frame 30
  const projectPath = await gameProject(
    t,
    'extends Node\n\nvar frames = 0\n\nfunc _ready():\n\tvar x = null\n\tx.foo()\n\nfunc _process(_delta):\n\tframes += 1\n\tif frames == 30:\n\t\tprint("still running after the error")\n\t\tget_tree().quit(4)\n'
  );

  await call(client, 'run_project', { projectPath });
  const run = await waitForRunEnd(client);

  assert.equal(run.running, false, 'game did not exit; it may be stopped at a debugger prompt');
  assert.equal(run.exitCode, 4);
  assert.ok(run.output.includes('still running after the error'), run.output.join('\n'));
  assert.ok(run.errors.some((line) => line.includes("SCRIPT ERROR: Invalid call. Nonexistent function 'foo'")), run.errors.join('\n'));
});

test('real Godot: the remote debugger reports each distinct error once, with its line', { skip }, async (t) => {
  const client = await realGodot(t);
  const projectPath = await gameProject(
    t,
    [
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
      '\tif frames == 120:', //                   11
      '\t\tget_tree().quit(3)', //                12
      '\tvar y = null', //                        13
      '\ty.bar()', //                             14
    ].join('\n') + '\n'
  );

  await call(client, 'run_project', { projectPath });
  const run = await waitForRunEnd(client);
  const find = (text) => run.reportedErrors.filter((error) => error.message.includes(text));

  assert.equal(run.exitCode, 3, 'the game should reach its quit, never pausing');
  assert.deepEqual(run.debugger, { attached: true });
  assert.deepEqual(find('pushed error').map(({ file, line, warning }) => ({ file, line, warning })), [{ file: 'res://main.gd', line: 5, warning: false }]);
  assert.deepEqual(find('pushed warning').map(({ line, warning }) => ({ line, warning })), [{ line: 6, warning: true }]);
  assert.deepEqual(find("'foo'").map(({ line }) => line), [8]);
  assert.deepEqual(find("'bar'").map(({ line }) => line), [14]);
  assert.ok(find("'bar'")[0].count > 100, `per-frame error count: ${find("'bar'")[0].count}`);
});

test('real Godot: inspect and change a running node', { skip }, async (t) => {
  const client = await realGodot(t);
  const scene = [
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="res://player.gd" id="1"]',
    '',
    '[node name="Main" type="Node"]',
    '',
    '[node name="Player" type="Node2D" parent="."]',
    'script = ExtResource("1")',
  ].join('\n') + '\n';
  const projectPath = await makeProject(t, {
    'project.godot': 'config_version=5\n\n[application]\n\nrun/main_scene="res://main.tscn"\n\n[autoload]\n\nScore="*res://score.gd"\n',
    'score.gd': 'extends Node\n\nvar points = 0\n',
    'player.gd': 'extends Node2D\n\n@export var speed = 0.0\nvar velocity = Vector2.ZERO\n@onready var target: Node = get_parent()\n\nfunc _process(delta):\n\tposition += velocity * delta\n',
    'main.tscn': scene,
  });

  await call(client, 'run_project', { projectPath });
  // The game connects to the debugger before it adds its autoloads and main scene, yet the first
  // tree must already have them; the short interval asks soon after the game connects
  let tree;
  await pollUntil(async () => {
    const reply = await call(client, 'get_scene_tree', {});
    if (!reply.isError) tree = JSON.parse(text(reply)).tree;
    return tree;
  }, { timeoutMs: 20000, intervalMs: 20 });
  assert.ok(tree, 'the game never connected to the debugger');
  const paths = [];
  const collect = (node) => { paths.push(node.path); node.children?.forEach(collect); };
  collect(tree);
  assert.ok(paths.includes('/root/Score') && paths.includes('/root/Main/Player'), paths.join(', '));

  const before = JSON.parse(text(await call(client, 'get_node_properties', { nodePath: '/root/Main/Player' })));
  assert.deepEqual(before.script, { velocity: [0, 0], speed: 0, target: { node: '/root/Main' } });
  assert.deepEqual(before.properties.position, [0, 0]);

  const cleared = JSON.parse(text(await call(client, 'set_node_property', { nodePath: '/root/Main/Player', property: 'target', value: null })));
  assert.equal(cleared.value, null);

  const set = JSON.parse(text(await call(client, 'set_node_property', { nodePath: '/root/Main/Player', property: 'velocity', value: { x: 120, y: 0 } })));
  assert.deepEqual(set.value, [120, 0]);
  let after;
  await pollUntil(async () => {
    after = JSON.parse(text(await call(client, 'get_node_properties', { nodePath: '/root/Main/Player', names: ['position'] })));
    return after.properties.position[0] > 10;
  }, { timeoutMs: 10000, intervalMs: 200 });
  assert.ok(after.properties.position[0] > 10, `position of the moving node: ${after.properties.position}`);

  assert.equal(await readFile(join(projectPath, 'main.tscn'), 'utf8'), scene, 'the scene file must not change');
  await call(client, 'stop_project', {});
});

test('real Godot: breakpoints, stepping, evaluate and breakOnError', { skip }, async (t) => {
  const client = await realGodot(t);
  // The player never moves: _ready resets speed to 0 (the scenario from #17)
  const player = [
    'extends Node2D', //                                   1
    '', //                                                 2
    '@export var speed = 120.0', //                        3
    'var velocity = Vector2.ZERO', //                      4
    'var direction = Vector2.RIGHT', //                    5
    '', //                                                 6
    'func _ready():', //                                   7
    '\tspeed = speed if speed < 100 else 0.0', //          8
    '\tvelocity = direction * speed', //                   9
    '', //                                                 10
    'func _process(delta):', //                            11
    '\tvar step = velocity * delta', //                    12
    '\tposition += step', //                               13
  ].join('\n') + '\n';
  const projectPath = await makeProject(t, {
    'project.godot': 'config_version=5\n\n[application]\n\nrun/main_scene="res://main.tscn"\n',
    'player.gd': player,
    'broken.gd': 'extends Node\n\nfunc _ready():\n\tvar x = null\n\tx.foo()\n',
    'main.tscn': '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://player.gd" id="1"]\n\n[node name="Main" type="Node"]\n\n[node name="Player" type="Node2D" parent="."]\nscript = ExtResource("1")\n',
    'broken.tscn': '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://broken.gd" id="1"]\n\n[node name="Broken" type="Node"]\nscript = ExtResource("1")\n',
  });
  const json = async (name, args = {}) => {
    const reply = await call(client, name, args);
    return { reply, value: JSON.parse(reply.content.at(-1).text) };
  };

  await call(client, 'set_breakpoint', { file: 'player.gd', line: 12 });
  await call(client, 'run_project', { projectPath });

  const hit = (await json('get_debug_state', { waitMs: 8000 })).value;
  assert.equal(hit.status, 'paused', JSON.stringify(hit));
  assert.equal(hit.pause.reason, 'breakpoint');
  assert.deepEqual(hit.pause.stack[0], { file: 'res://player.gd', line: 12, function: '_process' });
  assert.equal(typeof hit.pause.variables.locals.delta, 'number');
  assert.deepEqual(hit.pause.variables.members, { speed: 0, velocity: [0, 0], direction: [1, 0] });

  const output = await call(client, 'get_debug_output', {});
  assert.equal(output.content[0].text, 'Game paused at res://player.gd:12 (_process); use resume_game to continue');

  assert.deepEqual((await json('evaluate', { expression: 'direction * speed' })).value.value, [0, 0]);

  await call(client, 'set_node_property', { nodePath: '/root/Main/Player', property: 'speed', value: 55 });
  assert.equal((await json('get_debug_state')).value.pause.variables.members.speed, 55);

  const stepped = (await json('resume_game', { action: 'next' })).value;
  assert.equal(stepped.pause?.reason, 'step', JSON.stringify(stepped));
  assert.equal(stepped.pause.stack[0].line, 13);
  assert.deepEqual(stepped.pause.variables.locals.step, [0, 0]);

  await call(client, 'set_breakpoint', { file: 'player.gd', line: 12, enabled: false });
  assert.equal((await json('resume_game', { waitMs: 1000 })).value.status, 'running');

  const paused = (await json('pause_game')).value;
  assert.equal(paused.status, 'paused', JSON.stringify(paused));
  assert.equal(paused.pause.reason, 'pause');
  assert.equal((await json('resume_game', { waitMs: 500 })).value.status, 'running');
  await call(client, 'stop_project', {});

  // breakOnError pauses at the failing line; stop_project ends a paused game
  await call(client, 'run_project', { projectPath, scene: 'broken.tscn', breakOnError: true });
  const failed = (await json('get_debug_state', { waitMs: 8000 })).value;
  assert.equal(failed.pause?.reason, 'error', JSON.stringify(failed));
  assert.match(failed.pause.error, /Nonexistent function 'foo'/);
  assert.deepEqual(failed.pause.stack[0], { file: 'res://broken.gd', line: 5, function: '_ready' });
  const stopped = (await json('stop_project')).value;
  assert.equal(stopped.running, false);
});
