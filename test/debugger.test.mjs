// The remote debugger session behind run_project, with the test playing the game's side of the
// protocol using frames recorded from Godot 4.7.2.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { THREAD_ID, attach, debuggerFixtures, debuggerFrame, pollUntil, startGame } from './harness.mjs';

const { frames, lines, script } = debuggerFixtures();

async function setup(t, options) {
  const { game, json } = await startGame(t, options);
  // Poll get_debug_output until `ready(output)` holds, for up to 5 s; returns the last output either way
  const debugOutputWhen = async (ready) => {
    let output;
    await pollUntil(async () => ready((output = await json('get_debug_output'))));
    return output;
  };
  return { game, json, debugOutputWhen };
}

test('run_project attaches the debugger and tells the game not to pause', async (t) => {
  const { game, json, debugOutputWhen } = await setup(t);

  assert.match(game.args[game.args.indexOf('--remote-debug') + 1], /^tcp:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual((await json('get_debug_output')).debugger, { attached: false, reason: 'The game has not connected to the debugger' });

  const debug = await attach(game);
  await debug.waitFor('set_ignore_error_breaks');

  assert.deepEqual(debug.received, [
    ['set_skip_breakpoints', THREAD_ID, [true]],
    ['set_ignore_error_breaks', THREAD_ID, [true]],
  ]);
  assert.deepEqual((await debugOutputWhen((output) => output.debugger.attached)).debugger, { attached: true });
});

test('reported errors point at the script line, and repeats are merged', async (t) => {
  const { game, debugOutputWhen } = await setup(t);
  const debug = await attach(game);

  for (const key of ['push_error', 'push_warning', 'script_error_ready', 'script_error_process', 'script_error_process', 'script_error_process']) {
    debug.send(frames[key]);
  }
  const { reportedErrors } = await debugOutputWhen((output) => output.reportedErrors.find((error) => error.count === 3));
  const find = (text) => reportedErrors.find((error) => error.message.includes(text));

  assert.equal(reportedErrors.length, 4);
  assert.deepEqual(
    { ...find('pushed error'), firstSeenMs: 0, lastSeenMs: 0 },
    { message: 'pushed error', warning: false, file: script, line: lines.push_error, function: '_ready', count: 1, firstSeenMs: 0, lastSeenMs: 0 }
  );
  assert.equal(find('pushed warning').warning, true);
  assert.equal(find('pushed warning').line, lines.push_warning);
  assert.equal(find("'foo'").line, lines.script_error_ready);
  assert.equal(find("'bar'").count, 3);
  assert.equal(find("'bar'").line, lines.script_error_process);
  assert.ok(find("'bar'").firstSeenMs <= find("'bar'").lastSeenMs);
});

test('after 200 distinct errors, new ones are counted but not stored', async (t) => {
  const { game, debugOutputWhen } = await setup(t);
  const debug = await attach(game);
  const error = (n) => debuggerFrame('error', THREAD_ID, [0, 0, 0, 0, script, '_process', n, `error ${n}`, '', false, 3, script, '_process', n]);

  for (let n = 1; n <= 205; n++) debug.send(error(n));
  debug.send(error(1));
  const output = await debugOutputWhen((output) => output.droppedReportedErrors === 5 && output.reportedErrors[0].count === 2);

  assert.equal(output.reportedErrors.length, 200);
  assert.equal(output.droppedReportedErrors, 5);
  assert.equal(output.reportedErrors[0].count, 2);
});

test('before Godot 4.5, the server answers every break with continue', async (t) => {
  const { game } = await setup(t, { version: '4.4.1.stable.official' });
  const debug = await attach(game);

  debug.send(frames.debug_enter_error);
  await debug.waitFor('continue');

  assert.deepEqual(debug.received.map(([name]) => name), ['set_skip_breakpoints', 'continue']);
});

test('Godot 4.1 runs without the debugger', async (t) => {
  const { game, json } = await setup(t, { version: '4.1.3.stable.official' });

  assert.ok(!game.args.includes('--remote-debug'));
  assert.deepEqual((await json('get_debug_output')).debugger, {
    attached: false,
    reason: 'The remote debugger needs Godot 4.2 or later; this is 4.1.3.stable.official',
  });
});

test('the debugger can be turned off in the server configuration', async (t) => {
  const { game, json } = await setup(t, { config: { remoteDebugger: false } });

  assert.ok(!game.args.includes('--remote-debug'));
  assert.equal((await json('get_debug_output')).debugger.reason, 'The remote debugger is turned off in the server configuration');
});

test('a game that never connects still has its output captured', async (t) => {
  const { game, debugOutputWhen } = await setup(t);

  game.stdout.write('hello\n');
  const output = await debugOutputWhen((output) => output.output.length > 0);

  assert.deepEqual(output.output, ['hello']);
  assert.equal(output.debugger.attached, false);
  assert.deepEqual(output.reportedErrors, []);
});

test('stop_project returns the reported errors', async (t) => {
  const { game, json, debugOutputWhen } = await setup(t);
  const debug = await attach(game);
  debug.send(frames.script_error_ready);
  await debugOutputWhen((output) => output.reportedErrors.length === 1);

  const stopped = await json('stop_project');

  assert.deepEqual(stopped.debugger, { attached: true });
  assert.equal(stopped.reportedErrors.length, 1);
  assert.equal(stopped.droppedReportedErrors, 0);
});
