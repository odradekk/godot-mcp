// Request preparation: argument names, required parameters and pre-checks, seen through tool calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GODOT, GODOT_VERSION, connect, fakeLauncher, makeProject, text } from './harness.mjs';


// Godot that reports `version` and answers every operation with an empty success
function godot(version = GODOT_VERSION) {
  return (file, args) => {
    if (args[0] === '--version') return { stdout: `${version}\n` };
    return { stdout: `@@GODOT_MCP_RESULT@@ ${JSON.stringify({ ok: true, result: {} })}\n` };
  };
}

async function setup(t, { version } = {}) {
  const launcher = fakeLauncher(godot(version));
  const { client, close } = await connect({ godotPath: GODOT, launcher });
  t.after(close);
  const projectPath = await makeProject(t, {
    'main.tscn': '[gd_scene format=3]\n\n[node name="root" type="Node2D"]\n',
    'icon.tres': '[gd_resource type="GradientTexture2D" format=3]\n\n[resource]\n',
  });
  // Calls made while connecting are not part of any tool call
  const connectCalls = launcher.calls.length;
  const callsSinceConnect = () => launcher.calls.slice(connectCalls);
  return { client, launcher, projectPath, callsSinceConnect };
}

// Parameters Godot received for the last operation run
function operationParams(launcher) {
  const { args } = launcher.calls.at(-1);
  return JSON.parse(args[args.indexOf('--') + 2]);
}

test('each missing required parameter is reported by name before anything runs', async (t) => {
  const { client, projectPath, callsSinceConnect } = await setup(t);
  const valid = {
    projectPath,
    directory: projectPath,
    scenePath: 'main.tscn',
    nodeType: 'Sprite2D',
    nodeName: 'Hero',
    nodePath: 'root/Hero',
    texturePath: 'icon.tres',
    outputPath: 'lib.tres',
    filePath: 'main.tscn',
    property: 'speed',
    value: 1,
    file: 'player.gd',
    line: 12,
    expression: 'speed',
  };
  const { tools } = await client.listTools();

  for (const tool of tools) {
    for (const omitted of tool.inputSchema.required) {
      const args = Object.fromEntries(tool.inputSchema.required.filter((name) => name !== omitted).map((name) => {
        assert.ok(name in valid, `no valid test value for ${name}`);
        return [name, valid[name]];
      }));

      const result = await client.callTool({ name: tool.name, arguments: args });

      assert.equal(result.isError, true, `${tool.name} without ${omitted}`);
      assert.equal(result.content[0].text, `Missing required parameters: ${omitted}`);
    }
  }
  assert.deepEqual(callsSinceConnect(), []);
});

test('pre-checks reject bad arguments with one message per check, before Godot runs', async (t) => {
  const { client, projectPath, callsSinceConnect } = await setup(t);
  const cases = [
    ['add_node', { scenePath: '../main.tscn', nodeType: 'Node2D', nodeName: 'X' }, 'Invalid path in scenePath: ../main.tscn'],
    ['add_node', { scenePath: 'main.tscn', nodeType: 'res://evil.gd', nodeName: 'X' }, 'Invalid nodeType: res://evil.gd'],
    ['add_node', { scenePath: 'missing.tscn', nodeType: 'Node2D', nodeName: 'X' }, 'Scene file does not exist: missing.tscn'],
    ['load_sprite', { scenePath: 'main.tscn', nodePath: 'root', texturePath: 'missing.png' }, 'Texture file does not exist: missing.png'],
    ['run_project', { scene: 'missing.tscn' }, 'Scene file does not exist: missing.tscn'],
    ['save_scene', { scenePath: 'main.tscn', newPath: '../outside.tscn' }, 'Invalid path in newPath: ../outside.tscn'],
  ];

  for (const [name, args, message] of cases) {
    const result = await client.callTool({ name, arguments: { projectPath, ...args } });

    assert.equal(result.isError, true, name);
    assert.equal(result.content[0].text, message);
  }

  const notAProject = await client.callTool({ name: 'get_project_info', arguments: { projectPath: `${projectPath}/missing` } });
  assert.equal(notAProject.content[0].text, `Not a valid Godot project: ${projectPath}/missing`);
  const noDirectory = await client.callTool({ name: 'list_projects', arguments: { directory: `${projectPath}/missing` } });
  assert.equal(noDirectory.content[0].text, `Directory does not exist: ${projectPath}/missing`);

  assert.deepEqual(callsSinceConnect(), []);
});

test('UID tools require Godot 4.4', async (t) => {
  const { client, projectPath, callsSinceConnect } = await setup(t, { version: '4.3.stable.official' });

  const uid = await client.callTool({ name: 'get_uid', arguments: { projectPath, filePath: 'main.tscn' } });
  const update = await client.callTool({ name: 'update_project_uids', arguments: { projectPath } });

  for (const result of [uid, update]) {
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'Godot 4.4 or later is needed for UIDs; this is 4.3.stable.official');
  }
  // The version read while finding Godot serves both calls; no operation ran
  assert.deepEqual(callsSinceConnect(), []);
});

test('arguments of the wrong type, out of range or outside an enum are rejected before anything runs', async (t) => {
  const { client, projectPath, callsSinceConnect } = await setup(t);
  const cases = [
    ['set_breakpoint', { file: 'player.gd', line: '12' }, 'Invalid line: expected an integer of at least 1, got "12"'],
    ['set_breakpoint', { file: 'player.gd', line: 0 }, 'Invalid line: expected an integer of at least 1, got 0'],
    ['resume_game', { action: 'jump' }, 'Invalid action: expected one of continue, step, next, out, got "jump"'],
    ['get_debug_state', { waitMs: 70000 }, 'Invalid waitMs: expected a number from 0 to 60000, got 70000'],
    ['list_projects', { directory: projectPath, recursive: 'true' }, 'Invalid recursive: expected true or false, got "true"'],
    ['get_node_properties', { nodePath: '/root', names: [1] }, 'Invalid names: expected an array of strings, got [1]'],
  ];

  for (const [name, args, message] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.equal(result.content[0].text, message);
  }
  assert.deepEqual(callsSinceConnect(), []);
});

test('the input schema lists types, defaults, enums and bounds', async (t) => {
  const { client } = await setup(t);
  const { tools } = await client.listTools();
  const schema = (name) => tools.find((tool) => tool.name === name).inputSchema.properties;

  const { action, waitMs } = schema('resume_game');
  assert.deepEqual([action.enum, action.default], [['continue', 'step', 'next', 'out'], 'continue']);
  assert.deepEqual([waitMs.type, waitMs.minimum, waitMs.maximum, waitMs.default], ['number', 0, 60000, 5000]);
  assert.deepEqual([schema('set_breakpoint').line.type, schema('set_breakpoint').line.minimum], ['integer', 1]);
  assert.equal(schema('set_node_property').value.type, undefined);
});

test('snake_case names are accepted and Godot receives camelCase', async (t) => {
  const { client, launcher, projectPath } = await setup(t);

  const result = await client.callTool({
    name: 'create_scene',
    arguments: { project_path: projectPath, scene_path: 'level.tscn', root_node_type: 'Node3D' },
  });

  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(operationParams(launcher), { scenePath: 'level.tscn', rootNodeType: 'Node3D' });
});

test('keys inside add_node properties reach Godot unchanged', async (t) => {
  const { client, launcher, projectPath } = await setup(t);
  const properties = { scene_path: 1, node_type: 2, modulate: { r: 1, g: 0, b: 0 } };

  await client.callTool({
    name: 'add_node',
    arguments: { projectPath, scenePath: 'main.tscn', nodeType: 'Sprite2D', nodeName: 'Hero', properties },
  });

  assert.deepEqual(operationParams(launcher).properties, properties);
});

test('res:// paths and node paths with .. pass the pre-checks', async (t) => {
  const { client, launcher, projectPath, callsSinceConnect } = await setup(t);

  await client.callTool({
    name: 'load_sprite',
    arguments: { projectPath, scenePath: 'res://main.tscn', nodePath: 'root/Player/../Hero', texturePath: 'res://icon.tres' },
  });

  assert.equal(callsSinceConnect().length, 1);
  assert.deepEqual(operationParams(launcher), { scenePath: 'res://main.tscn', nodePath: 'root/Player/../Hero', texturePath: 'res://icon.tres' });
});
