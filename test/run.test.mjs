// run_project, get_debug_output, stop_project and launch_editor against a fake game process.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GODOT, connect, fakeLauncher, godotAt, makeProject, text } from './harness.mjs';


// Let stream data and close events reach the server
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function setup(t, config = {}) {
  const launcher = fakeLauncher(godotAt(GODOT));
  const { client, close } = await connect({ godotPath: GODOT, launcher, ...config });
  t.after(close);
  const projectPath = await makeProject(t);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  return {
    launcher,
    close,
    call,
    projectPath,
    // Start a run and return its fake process
    run: async () => {
      await call('run_project', { projectPath });
      return launcher.children.at(-1);
    },
    debugOutput: async () => {
      await settle();
      return JSON.parse(text(await call('get_debug_output')));
    },
    stop: async () => {
      await settle();
      return call('stop_project');
    },
  };
}

test('a line split across chunks is one line, and CRLF leaves no empty lines', async (t) => {
  const { run, debugOutput } = await setup(t);
  const game = await run();

  game.stdout.write('Hello, ');
  game.stdout.write('world\r\nsecond');
  game.stdout.write(' line\r\n\r\n');

  assert.deepEqual((await debugOutput()).output, ['Hello, world', 'second line']);
});

test('each stream keeps its most recent 1000 lines and counts the dropped ones', async (t) => {
  const { run, debugOutput } = await setup(t);
  const game = await run();

  game.stdout.write(Array.from({ length: 1005 }, (_, i) => `line ${i + 1}\n`).join(''));

  const output = await debugOutput();
  assert.equal(output.output.length, 1000);
  assert.equal(output.output[0], 'line 6');
  assert.equal(output.droppedOutputLines, 5);
  assert.equal(output.droppedErrorLines, 0);
});

test('stop_project waits for the exit and returns the final output and exit code', async (t) => {
  const { run, stop } = await setup(t);
  const game = await run();
  game.kill = () => {
    game.exit(1);
    return true;
  };

  game.stdout.write('last line without a newline');
  game.stderr.write('a warning\n');
  const result = JSON.parse(text(await stop()));

  assert.equal(result.message, 'Godot project stopped');
  assert.equal(result.running, false);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.finalOutput, ['last line without a newline']);
  assert.deepEqual(result.finalErrors, ['a warning']);
});

test('stop_project ends a game that ignores SIGTERM with SIGKILL', async (t) => {
  const { run, stop } = await setup(t, { stopTimeoutMs: 50 });
  const game = await run();
  game.ignoredSignals = ['SIGTERM'];

  const result = JSON.parse(text(await stop()));

  assert.deepEqual(game.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.message, 'Godot project stopped');
  assert.equal(result.running, false);
});

test('a new run ends a previous game that ignores SIGTERM with SIGKILL', async (t) => {
  const { run, debugOutput } = await setup(t, { stopTimeoutMs: 50 });
  const first = await run();
  first.ignoredSignals = ['SIGTERM'];

  const second = await run();
  second.stdout.write('from the second run\n');

  assert.deepEqual(first.signals, ['SIGTERM', 'SIGKILL']);
  const output = await debugOutput();
  assert.equal(output.running, true);
  assert.deepEqual(output.output, ['from the second run']);
});

test('a game that survives SIGKILL is reported as still running', async (t) => {
  const { run, stop } = await setup(t, { stopTimeoutMs: 50 });
  const game = await run();
  game.ignoredSignals = ['SIGTERM', 'SIGKILL'];
  // Without an exit, the run's debugger listener would keep the test process alive
  t.after(() => game.exit(null));

  const result = JSON.parse(text(await stop()));

  assert.equal(result.message, 'Godot project did not exit within 0.05 s of SIGTERM or 0.05 s of SIGKILL');
  assert.equal(result.running, true);
});

test('a new run replaces the running one without mixing their output', async (t) => {
  const { run, debugOutput } = await setup(t);
  const first = await run();
  first.stdout.write('from the first run\n');

  const second = await run();
  second.stdout.write('from the second run\n');

  assert.equal(first.killed, true);
  assert.deepEqual((await debugOutput()).output, ['from the second run']);
});

test('output and exit code stay readable after the game exits', async (t) => {
  const { call, run, debugOutput } = await setup(t);
  const game = await run();

  game.stdout.write('done\n');
  game.exit(0);
  const output = await debugOutput();
  const stopped = await call('stop_project');

  assert.equal(output.running, false);
  assert.equal(output.exitCode, 0);
  assert.deepEqual(output.output, ['done']);
  assert.equal(stopped.isError, true);
  assert.equal(stopped.content[0].text, 'No running Godot process to stop.');
});

test('closing the server stops the running game', async (t) => {
  const { close, run } = await setup(t);
  const game = await run();

  await close();

  assert.equal(game.killed, true);
});

test('get_debug_state before any run_project says to start a game', async (t) => {
  const { call } = await setup(t);

  const reply = await call('get_debug_state');

  assert.equal(reply.content[0].text, 'No game has been started. Use run_project first.');
});

test('launch_editor starts the editor detached from the server', async (t) => {
  const { call, launcher, projectPath } = await setup(t);

  await call('launch_editor', { projectPath });

  assert.deepEqual(launcher.calls.at(-1).options, { detached: true });
});
