import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { test } from 'node:test';

import { GODOT_VERSION, connect, fakeLauncher, godotAt, text } from './harness.mjs';

test('lists the Godot tools', async (t) => {
  const { client, close } = await connect({ godotPath: '/opt/godot', launcher: fakeLauncher(godotAt('/opt/godot')) });
  t.after(close);

  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'add_node',
    'create_scene',
    'evaluate',
    'export_mesh_library',
    'get_debug_output',
    'get_debug_state',
    'get_godot_version',
    'get_node_properties',
    'get_project_info',
    'get_scene_tree',
    'get_uid',
    'launch_editor',
    'list_breakpoints',
    'list_projects',
    'load_sprite',
    'pause_game',
    'resume_game',
    'run_project',
    'save_scene',
    'set_breakpoint',
    'set_node_property',
    'stop_project',
    'update_project_uids',
  ]);
});

test('the server reports the package version', async (t) => {
  const { client, close } = await connect({ godotPath: '/opt/godot', launcher: fakeLauncher(godotAt('/opt/godot')) });
  t.after(close);
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(client.getServerVersion().version, version);
});

test('get_godot_version returns the version Godot reports', async (t) => {
  const { client, close } = await connect({ godotPath: '/opt/godot', launcher: fakeLauncher(godotAt('/opt/godot')) });
  t.after(close);

  const result = await client.callTool({ name: 'get_godot_version', arguments: {} });

  assert.equal(result.isError, undefined);
  assert.equal(text(result), GODOT_VERSION);
});

// Returns the Godot binary the server runs for a tool call after connecting with `config`
// on a machine where Godot is installed at `installed`.
async function godotUsed(config, installed) {
  const launcher = fakeLauncher(godotAt(...installed));
  const { client, close } = await connect({ ...config, launcher });
  try {
    await client.callTool({ name: 'get_godot_version', arguments: {} });
    return launcher.calls.at(-1).file;
  } finally {
    await close();
  }
}

const detectionCases = [
  {
    name: 'configured path wins over GODOT_PATH',
    config: { godotPath: '/cfg/godot', env: { GODOT_PATH: '/env/godot' } },
    installed: ['/cfg/godot', '/env/godot'],
    expected: '/cfg/godot',
  },
  {
    name: 'invalid configured path falls back to GODOT_PATH',
    config: { godotPath: '/missing/godot', env: { GODOT_PATH: '/env/godot' } },
    installed: ['/env/godot'],
    expected: '/env/godot',
  },
  {
    name: 'GODOT_PATH wins over install locations',
    config: { platform: 'linux', env: { GODOT_PATH: '/env/godot' } },
    installed: ['/env/godot', '/usr/bin/godot'],
    expected: '/env/godot',
  },
  {
    name: 'godot on PATH is tried before install locations',
    config: { platform: 'linux', env: {} },
    installed: ['godot', '/usr/bin/godot'],
    expected: 'godot',
  },
  {
    name: 'linux install locations are tried in order',
    config: { platform: 'linux', env: { HOME: '/home/dev' } },
    installed: ['/usr/local/bin/godot', '/home/dev/.local/bin/godot'],
    expected: '/usr/local/bin/godot',
  },
  {
    name: 'linux user install under HOME',
    config: { platform: 'linux', env: { HOME: '/home/dev' } },
    installed: ['/home/dev/.local/bin/godot'],
    expected: '/home/dev/.local/bin/godot',
  },
  {
    name: 'macOS application under HOME',
    config: { platform: 'darwin', env: { HOME: '/Users/dev' } },
    installed: ['/Users/dev/Applications/Godot_4.app/Contents/MacOS/Godot'],
    expected: '/Users/dev/Applications/Godot_4.app/Contents/MacOS/Godot',
  },
  {
    name: 'Windows install under Program Files',
    config: { platform: 'win32', env: { USERPROFILE: 'C:\\Users\\dev' } },
    installed: ['C:\\Program Files\\Godot_4\\Godot.exe', 'C:\\Users\\dev\\Godot\\Godot.exe'],
    expected: 'C:\\Program Files\\Godot_4\\Godot.exe',
  },
  {
    name: 'Windows install under USERPROFILE',
    config: { platform: 'win32', env: { USERPROFILE: 'C:\\Users\\dev' } },
    installed: ['C:\\Users\\dev\\Godot\\Godot.exe'],
    expected: 'C:\\Users\\dev\\Godot\\Godot.exe',
  },
];

for (const { name, config, installed, expected } of detectionCases) {
  test(`Godot detection: ${name}`, async () => {
    assert.equal(await godotUsed(config, installed), normalize(expected));
  });
}

test('connect fails in strict mode when no Godot is found', async () => {
  await assert.rejects(
    connect({ strictPathValidation: true, platform: 'linux', launcher: fakeLauncher(godotAt()) }),
    /Could not find a valid Godot executable/
  );
});

test('get_project_info reports the name from project.godot', async (t) => {
  const projectPath = await mkdtemp(join(tmpdir(), 'godot-mcp-test-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  await writeFile(join(projectPath, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Demo Game"\n');
  const { client, close } = await connect({ godotPath: '/opt/godot', launcher: fakeLauncher(godotAt('/opt/godot')) });
  t.after(close);

  const result = await client.callTool({ name: 'get_project_info', arguments: { projectPath } });

  assert.equal(result.isError, undefined);
  const info = JSON.parse(text(result));
  assert.equal(info.name, 'Demo Game');
  assert.equal(info.godotVersion, GODOT_VERSION);
});
