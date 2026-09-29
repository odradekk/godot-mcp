// Runs against a real Godot binary. Skipped unless GODOT_PATH is set.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
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
  assert.match(missingNode.content[0].text, /^Failed to load sprite: Node not found: root\/Missing/);

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
