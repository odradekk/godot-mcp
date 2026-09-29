// Runs against a real Godot binary. Skipped unless GODOT_PATH is set.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { connect, makeProject, text } from './harness.mjs';

const godotPath = process.env.GODOT_PATH;
const skip = !godotPath && 'GODOT_PATH is not set';

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
  for (let attempt = 0; attempt < 100; attempt++) {
    run = JSON.parse(text(await call(client, 'get_debug_output', {})));
    if (!run.running) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
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
