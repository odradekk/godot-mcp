// Operation tools against a fake Godot that replays the output shapes a real run produces.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GODOT, connect, fakeLauncher, godotAt, makeProject, text } from './harness.mjs';

const BANNER = 'Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org\n\n';
const LEAK_WARNING = 'WARNING: 1 RID of type "CanvasItem" was leaked.\n   at: _free_rids (servers/rendering/renderer_canvas_cull.cpp:2733)\n';

const report = (outcome) => `@@GODOT_MCP_RESULT@@ ${JSON.stringify(outcome)}\n`;

// Godot installed at GODOT whose operation runs are answered by `operation(args)`.
function godotRunning(operation) {
  const version = godotAt(GODOT);
  return (file, args) => (args.includes('--script') ? operation(args) : version(file, args));
}

async function setup(t, operation, config = {}, respond = godotRunning(operation)) {
  const launcher = fakeLauncher(respond);
  const { client, close } = await connect({ godotPath: GODOT, launcher, ...config });
  t.after(close);
  const projectPath = await makeProject(t, { 'main.tscn': '[gd_scene format=3]\n\n[node name="root" type="Node2D"]\n' });
  return { client, launcher, projectPath };
}

test('a reported result is the reply; engine banner and warnings are not', async (t) => {
  const { client, projectPath } = await setup(t, () => ({
    stdout: `${BANNER}[INFO] Operation: create_scene\n${report({ ok: true, result: { scenePath: 'res://level.tscn', rootNodeType: 'Node2D' } })}`,
    stderr: LEAK_WARNING,
  }));

  const result = await client.callTool({ name: 'create_scene', arguments: { projectPath, scenePath: 'level.tscn' } });

  assert.equal(result.isError, undefined);
  assert.equal(text(result), 'Scene created successfully at: res://level.tscn');
});

test('a reported failure leads the reply with the operation message', async (t) => {
  const { client, projectPath } = await setup(t, () => ({
    stdout: `${BANNER}${report({ ok: false, error: "Unknown property 'speed' on node type: Sprite2D" })}`,
    stderr: `[ERROR] Unknown property 'speed' on node type: Sprite2D\n${LEAK_WARNING}`,
    exitCode: 1,
  }));

  const result = await client.callTool({
    name: 'add_node',
    arguments: { projectPath, scenePath: 'main.tscn', nodeType: 'Sprite2D', nodeName: 'Hero', properties: { speed: 3 } },
  });

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Failed to add node: Unknown property 'speed' on node type: Sprite2D");
  assert.doesNotMatch(text(result), /leaked/);
});

test('a run that reports nothing fails with the exit code and stderr, whatever the exit code', async (t) => {
  for (const exitCode of [0, 1]) {
    const { client, projectPath } = await setup(t, () => ({
      stdout: BANNER,
      stderr: "SCRIPT ERROR: Invalid call. Nonexistent function 'foo' in base 'Nil'.\n",
      exitCode,
    }));

    const result = await client.callTool({ name: 'save_scene', arguments: { projectPath, scenePath: 'main.tscn' } });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, new RegExp(`exited with code ${exitCode} without reporting a result`));
    assert.match(result.content[0].text, /SCRIPT ERROR: Invalid call/);
  }
});

test('a launcher failure such as a timeout becomes a failed reply', async (t) => {
  const { client, launcher, projectPath } = await setup(
    t,
    () => {
      throw new Error('Godot timed out after 1 s and the process was stopped');
    },
    { operationTimeoutMs: 1000 }
  );

  const result = await client.callTool({ name: 'save_scene', arguments: { projectPath, scenePath: 'main.tscn' } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Failed to save scene: Godot timed out after 1 s/);
  assert.equal(launcher.calls.at(-1).options.timeoutMs, 1000);
});

test('get_uid returns the UID object as JSON', async (t) => {
  const uid = { file: 'res://main.tscn', absolutePath: '/p/main.tscn', exists: true, uid: 'uid://b1x2y3' };
  const { client, projectPath } = await setup(t, () => ({ stdout: `${BANNER}${report({ ok: true, result: uid })}` }));

  const result = await client.callTool({ name: 'get_uid', arguments: { projectPath, filePath: 'main.tscn' } });

  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(text(result)), uid);
});

test('Godot debug output is off unless debugMode is on, and then failures include it', async (t) => {
  const failing = () => ({ stdout: `${BANNER}[DEBUG] Params JSON: {}\n${report({ ok: false, error: 'Boom' })}`, exitCode: 1 });
  const quiet = await setup(t, failing);
  const verbose = await setup(t, failing, { debugMode: true });

  const quietResult = await quiet.client.callTool({ name: 'save_scene', arguments: { projectPath: quiet.projectPath, scenePath: 'main.tscn' } });
  const verboseResult = await verbose.client.callTool({ name: 'save_scene', arguments: { projectPath: verbose.projectPath, scenePath: 'main.tscn' } });

  assert.ok(!quiet.launcher.calls.at(-1).args.includes('--debug-godot'));
  assert.ok(verbose.launcher.calls.at(-1).args.includes('--debug-godot'));
  assert.doesNotMatch(text(quietResult), /Godot output/);
  assert.match(text(verboseResult), /Godot output \(last 40 lines\):\n[\s\S]*\[DEBUG\] Params JSON/);
});

test('update_project_uids reports a failed import without running the resave', async (t) => {
  const respond = (file, args) => {
    if (args.includes('--import')) return { stderr: 'ERROR: Import failed\n', exitCode: 1 };
    if (args.includes('--script')) throw new Error('the resave operation must not run');
    return godotAt(GODOT)(file, args);
  };
  const { client, projectPath } = await setup(t, null, {}, respond);

  const result = await client.callTool({ name: 'update_project_uids', arguments: { projectPath } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Failed to update project UIDs: Godot import exited with code 1\. Godot stderr:\nERROR: Import failed/);
});

test('update_project_uids reports an import the launcher stopped as an update failure', async (t) => {
  const respond = (file, args) => {
    if (args.includes('--import')) throw new Error('Godot timed out after 1 s and the process was stopped');
    return godotAt(GODOT)(file, args);
  };
  const { client, projectPath } = await setup(t, null, {}, respond);

  const result = await client.callTool({ name: 'update_project_uids', arguments: { projectPath } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Failed to update project UIDs: Godot timed out after 1 s/);
  assert.match(result.content[1].text, /Check if the project is valid/);
});
