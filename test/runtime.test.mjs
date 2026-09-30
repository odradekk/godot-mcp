// get_scene_tree, get_node_properties and set_node_property, with the test playing the game's side
// of the debugger protocol using frames recorded from Godot 4.7.2 (see
// scripts/record-debugger-fixtures.mjs for the recorded scene).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GODOT, THREAD_ID, attach, connect, debuggerFixtures, debuggerFrame, fakeLauncher, godotReporting, makeProject, startGame, text } from './harness.mjs';
import { variantToJson } from '../build/runtime-values.js';
import { TypedVariant, decodeVariant } from '../build/variant.js';

const { frames } = debuggerFixtures();

// A running game with the debugger attached; the fake game answers tree and inspect requests
async function setup(t, { version, inspect = frames.inspect_player } = {}) {
  const { game, call, json } = await startGame(t, { version });
  const debug = await attach(game);
  debug.answer('scene:request_scene_tree', frames.scene_tree);
  debug.answer('scene:inspect_objects', inspect);
  debug.answer('scene:inspect_object', frames.inspect_object_player);
  return { debug, call, json };
}

const sent = (debug, name) => debug.received.filter(([messageName]) => messageName === name);

test('get_scene_tree lists the live tree with paths, types and scripts', async (t) => {
  const { json } = await setup(t);

  const { tree } = await json('get_scene_tree');

  assert.deepEqual(tree, {
    name: 'root',
    path: '/root',
    type: 'Window',
    children: [
      { name: 'GameState', path: '/root/GameState', script: 'res://game_state.gd' },
      {
        name: 'Main',
        path: '/root/Main',
        script: 'res://main.gd',
        scene: 'res://main.tscn',
        children: [
          { name: 'Player', path: '/root/Main/Player', script: 'res://player.gd', children: [{ name: 'Sprite', path: '/root/Main/Player/Sprite', type: 'Sprite2D' }] },
          { name: 'HUD', path: '/root/Main/HUD', type: 'CanvasLayer', children: [{ name: 'Label', path: '/root/Main/HUD/Label', type: 'Label' }] },
        ],
      },
    ],
  });
});

test('get_scene_tree lists a subtree and stops at maxNodes', async (t) => {
  const { json } = await setup(t);

  const subtree = await json('get_scene_tree', { path: 'root/Main/HUD' });
  const limited = await json('get_scene_tree', { maxNodes: 3 });

  assert.deepEqual(subtree.tree.children.map((node) => node.path), ['/root/Main/HUD/Label']);
  assert.equal(limited.omittedNodes, 4); // 7 nodes, 3 listed
  assert.deepEqual(limited.tree.children.map((node) => node.name), ['GameState', 'Main']);
});

// The game connects to the debugger before it adds its autoloads and main scene to the root
const emptyRoot = debuggerFrame('scene:scene_tree', THREAD_ID, [0, 'root', 'Window', 1, '', 0]);
function startsAfter(emptyReplies) {
  let requests = 0;
  return () => [requests++ < emptyReplies ? emptyRoot : frames.scene_tree];
}

test('get_scene_tree waits for a starting game to add its main scene', async (t) => {
  const { debug, json } = await setup(t);
  debug.answer('scene:request_scene_tree', startsAfter(2));

  const { tree } = await json('get_scene_tree');

  assert.deepEqual(tree.children.map((node) => node.name), ['GameState', 'Main']);
});

test('node lookups wait for a starting game to add its main scene', async (t) => {
  const { debug, json } = await setup(t);
  debug.answer('scene:request_scene_tree', startsAfter(2));

  const properties = await json('get_node_properties', { nodePath: '/root/Main/Player' });

  assert.equal(properties.node.path, '/root/Main/Player');
});

test('get_scene_tree says so when the game has not added its main scene in time', async (t) => {
  const { debug, json } = await setup(t);
  debug.answer('scene:request_scene_tree', emptyRoot);

  const reply = await json('get_scene_tree');

  assert.deepEqual(reply, {
    tree: { name: 'root', path: '/root', type: 'Window' },
    note: 'The game has not added its autoloads and main scene yet; try again in a moment',
  });
});

test('get_node_properties separates script variables from engine properties, as plain JSON', async (t) => {
  const { json } = await setup(t);

  const result = await json('get_node_properties', { nodePath: '/root/Main/Player' });

  assert.deepEqual(result.node, { path: '/root/Main/Player', class: 'Node2D', script: 'res://player.gd' });
  assert.deepEqual(result.script, {
    velocity: [1, 2],
    tint: { r: 1, g: 0, b: 0, a: 1 },
    target: { node: '/root/Main' },
    speed: 120,
  });
  assert.deepEqual(result.properties.position, [10, 20]);
  assert.deepEqual(result.properties.modulate, { r: 1, g: 1, b: 1, a: 1 });
  for (const leftOut of ['Node2D', 'Transform', 'Node/path', 'Constants/MAX_SPEED', 'script', 'name']) {
    assert.ok(!(leftOut in result.properties) && !(leftOut in result.script), `${leftOut} should be left out`);
  }
});

test('get_node_properties returns only the requested names, and reports unknown ones', async (t) => {
  const { json } = await setup(t);

  const result = await json('get_node_properties', { nodePath: '/root/Main/Player', names: ['speed', 'position', 'nope'] });

  assert.deepEqual(result.script, { speed: 120 });
  assert.deepEqual(result.properties, { position: [10, 20] });
  assert.deepEqual(result.unknownNames, ['nope']);
});

test('a resource-valued property is reported by its path', async (t) => {
  const { json } = await setup(t, { inspect: frames.inspect_sprite });

  const result = await json('get_node_properties', { nodePath: '/root/Main/Player/Sprite', names: ['texture'] });

  assert.deepEqual(result.properties, { texture: { resource: 'res://gradient.tres' } });
});

test('"/" is the window root', async (t) => {
  const { json } = await setup(t);

  const { tree } = await json('get_scene_tree', { path: '/' });
  const { node } = await json('get_node_properties', { nodePath: '/' });

  assert.equal(tree.path, '/root');
  assert.equal(node.path, '/root');
});

test('an unknown node path refreshes the tree once, then suggests the closest paths', async (t) => {
  const { call, debug } = await setup(t);
  await call('get_scene_tree');

  const result = await call('get_node_properties', { nodePath: '/root/Main/Plyer' });

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'No node at /root/Main/Plyer in the running game');
  assert.match(text(result), /Closest paths: \/root\/Main, /);
  assert.equal(sent(debug, 'scene:request_scene_tree').length, 2);
});

test('a node that no longer exists is reported', async (t) => {
  const { call } = await setup(t, { inspect: frames.inspect_missing });

  const result = await call('get_node_properties', { nodePath: '/root/Main/Player' });

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'The node at /root/Main/Player no longer exists');
});

test('Godot before 4.5 is inspected with inspect_object', async (t) => {
  const { json, debug } = await setup(t, { version: '4.4.1.stable.official' });

  const result = await json('get_node_properties', { nodePath: '/root/Main/Player', names: ['speed'] });

  assert.deepEqual(result.script, { speed: 120 });
  assert.equal(sent(debug, 'scene:inspect_objects').length, 0);
  assert.equal(sent(debug, 'scene:inspect_object').length, 1);
});

// Variant type of the value in a scene:set_object_property message [name, tid, [id, property, value]]
function sentValueType(raw) {
  let pos = 8; // outer array header and count
  [, pos] = decodeVariant(raw, pos); // name
  [, pos] = decodeVariant(raw, pos); // thread id
  pos += 8; // data array header and count
  [, pos] = decodeVariant(raw, pos); // object id
  [, pos] = decodeVariant(raw, pos); // property
  return raw.readUInt32LE(pos) & 0xff;
}

test('set_node_property encodes the JSON value as the property type', async (t) => {
  const { call, debug } = await setup(t);
  const cases = [
    ['velocity', { x: 120, y: 0 }, 'Members/velocity', 5, [120, 0]], // Vector2, from the current value
    ['tint', { r: 0, g: 1, b: 0 }, 'Members/tint', 20, [0, 1, 0, 1]], // Color, alpha defaults to 1
    ['speed', 200, 'speed', 3, 200], // float, as declared
    ['position', [5, 6], 'position', 5, [5, 6]],
    ['visible', false, 'visible', 1, false],
    ['target', null, 'Members/target', 0, null], // a node reference, cleared
    ['material', null, 'material', 0, null], // an Object property, cleared
  ];

  for (const [property, value, sentName, variantType, decoded] of cases) {
    const before = debug.received.length;
    const result = await call('set_node_property', { nodePath: 'root/Main/Player', property, value });
    assert.equal(result.isError, undefined, text(result));

    const index = debug.received.findIndex(([name], i) => i >= before && name === 'scene:set_object_property');
    const [, , [, name, sentValue]] = debug.received[index];
    assert.equal(name, sentName);
    assert.deepEqual(sentValue instanceof TypedVariant ? sentValue.value : sentValue, decoded);
    assert.equal(sentValueType(debug.rawReceived[index]), variantType, property);
  }
});

test('set_node_property rejects values it cannot convert, before sending anything', async (t) => {
  const { call, debug } = await setup(t);

  const object = await call('set_node_property', { nodePath: '/root/Main/Player', property: 'material', value: 'res://m.tres' });
  const shape = await call('set_node_property', { nodePath: '/root/Main/Player', property: 'position', value: 'left' });
  const nullVector = await call('set_node_property', { nodePath: '/root/Main/Player', property: 'position', value: null });
  const unknown = await call('set_node_property', { nodePath: '/root/Main/Player', property: 'nope', value: 1 });

  assert.match(object.content[0].text, /^Cannot set material: An Object property can only be set to null\. Settable types: bool, int/);
  assert.equal(shape.content[0].text, 'Cannot set position: "left" does not fit a VECTOR2 property');
  assert.equal(nullVector.content[0].text, 'Cannot set position: null does not fit a VECTOR2 property');
  assert.equal(unknown.content[0].text, '/root/Main/Player has no property or script variable named nope');
  assert.equal(sent(debug, 'scene:set_object_property').length, 0);
});

test('runtime tools explain why they cannot answer', async (t) => {
  const launcher = fakeLauncher(godotReporting('4.7.2.stable.official'));
  const { client, close } = await connect({ godotPath: GODOT, launcher });
  t.after(close);
  const call = async () => (await client.callTool({ name: 'get_scene_tree', arguments: {} })).content[0].text;

  const notStarted = await call();
  await client.callTool({ name: 'run_project', arguments: { projectPath: await makeProject(t) } });
  const notConnected = await call();

  assert.equal(notStarted, 'No game has been started. Use run_project first.');
  assert.equal(notConnected, 'The game has not connected to the debugger yet; try again in a moment');
});

test('a Dictionary with an objectId key stays a Dictionary', () => {
  // { "objectId": <int64> }: Dictionary header, one entry, String key, 64-bit INT value
  const key = Buffer.from('objectId');
  const buf = Buffer.alloc(4 + 4 + 8 + key.length + 12);
  buf.writeUInt32LE(27, 0);
  buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(4, 8);
  buf.writeUInt32LE(key.length, 12);
  key.copy(buf, 16);
  buf.writeUInt32LE(2 | (1 << 16), 16 + key.length);
  buf.writeBigInt64LE(2n ** 60n, 20 + key.length);

  const [dictionary] = decodeVariant(buf);

  assert.deepEqual(variantToJson(dictionary, () => '/root/Main'), { objectId: String(2n ** 60n) });
});
