// Runs against a real Godot binary. Skipped unless GODOT_PATH is set.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { connect, text } from './harness.mjs';

const godotPath = process.env.GODOT_PATH;

test('real Godot: version and project info', { skip: !godotPath && 'GODOT_PATH is not set' }, async (t) => {
  const { client, close } = await connect({ godotPath, strictPathValidation: true });
  t.after(close);
  const projectPath = await mkdtemp(join(tmpdir(), 'godot-mcp-it-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  await writeFile(join(projectPath, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Integration Demo"\n');

  const version = await client.callTool({ name: 'get_godot_version', arguments: {} });
  const info = await client.callTool({ name: 'get_project_info', arguments: { projectPath } });

  assert.equal(version.isError, undefined);
  assert.match(text(version), /^\d+\.\d+/);
  assert.equal(info.isError, undefined);
  const project = JSON.parse(text(info));
  assert.equal(project.name, 'Integration Demo');
  assert.equal(project.godotVersion, text(version));
});
