// Breakpoints, pausing, stepping and evaluate, with the test playing the game's side of the
// debugger protocol using frames recorded from Godot 4.7.2 on the #17 scenario (see
// scripts/record-debugger-fixtures.mjs, run 4).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { THREAD_ID, attach, debuggerFixtures, debuggerFrame, startGame, text } from './harness.mjs';

const { frames, lines } = debuggerFixtures();
const PAUSED_NOTE = `Game paused at res://player.gd:${lines.breakpoint} (_process); use resume_game to continue`;
const frameVars = ['stack_frame_vars', 'stack_frame_var_delta', 'stack_frame_var_step', 'stack_frame_var_self', 'stack_frame_var_speed', 'stack_frame_var_velocity', 'stack_frame_var_direction'].map((key) => frames[key]);

async function setup(t, { version, breakOnError = false, before } = {}) {
  const { game, call, json } = await startGame(t, { version, config: { stopTimeoutMs: 200 }, runArgs: { breakOnError }, before });
  const debug = await attach(game);
  debug.answer('get_stack_dump', frames.stack_dump);
  debug.answer('get_stack_frame_vars', ...frameVars);
  debug.answer('evaluate', frames.evaluation_return);

  const hitBreakpoint = async () => {
    const waiting = json('get_debug_state', { waitMs: 2000 });
    debug.send(frames.debug_enter_breakpoint);
    return waiting;
  };
  const messages = (name) => debug.received.filter(([messageName]) => messageName === name).map(([, , data]) => data);
  return { game, debug, call, json, hitBreakpoint, messages };
}

test('breakpoints are sent on connect and on change; breakpoint skipping follows whether any are set', async (t) => {
  const { call, debug, messages } = await setup(t, {
    before: (call) => call('set_breakpoint', { file: 'player.gd', line: lines.breakpoint }),
  });
  await debug.waitFor('breakpoint');

  assert.deepEqual(messages('set_skip_breakpoints'), [[false]]);
  assert.deepEqual(messages('breakpoint'), [['res://player.gd', lines.breakpoint, true]]);

  const cleared = JSON.parse(text(await call('set_breakpoint', { file: 'res://player.gd', line: lines.breakpoint, enabled: false })));
  await debug.waitFor('set_skip_breakpoints', { count: 2 });

  assert.deepEqual(cleared, { breakpoints: [] });
  assert.deepEqual(messages('breakpoint').at(-1), ['res://player.gd', lines.breakpoint, false]);
  assert.deepEqual(messages('set_skip_breakpoints').at(-1), [true]);
});

test('a breakpoint hit while get_debug_state waits returns the whole pause state', async (t) => {
  const { hitBreakpoint } = await setup(t);

  const state = await hitBreakpoint();

  assert.deepEqual(state, {
    status: 'paused',
    pause: {
      reason: 'breakpoint',
      stack: [{ file: 'res://player.gd', line: lines.breakpoint, function: '_process' }],
      frame: 0,
      variables: {
        locals: { delta: 0.016666666666666666, step: null },
        members: { speed: 0, velocity: [0, 0], direction: [1, 0] },
      },
    },
  });
});

test('resume_game next steps with breakpoint skipping off and returns the next location', async (t) => {
  const { debug, json, hitBreakpoint, messages } = await setup(t);
  await hitBreakpoint();
  debug.answer('next', frames.debug_exit, frames.debug_enter_step);
  debug.answer('get_stack_dump', debuggerFrame('stack_dump', THREAD_ID, [3, 'res://player.gd', lines.step, '_process']));

  const state = await json('resume_game', { action: 'next' });

  assert.equal(state.pause.reason, 'step');
  assert.deepEqual(state.pause.stack[0], { file: 'res://player.gd', line: lines.step, function: '_process' });
  assert.deepEqual(messages('set_skip_breakpoints').at(-1), [false]);
  assert.deepEqual(messages('next'), [[]]);
});

test('resume_game continue returns running when the game does not pause again', async (t) => {
  const { debug, json, hitBreakpoint } = await setup(t);
  await hitBreakpoint();
  debug.answer('continue', frames.debug_exit);

  const state = await json('resume_game', { waitMs: 200 });

  assert.deepEqual(state, { status: 'running' });
});

test('resume_game returns exited when the game exits while it waits', async (t) => {
  const { game, debug, json, hitBreakpoint } = await setup(t);
  await hitBreakpoint();
  debug.answer('continue', frames.debug_exit);

  const started = Date.now();
  const resuming = json('resume_game', { waitMs: 60000 });
  await debug.waitFor('continue');
  game.exit(0);
  const state = await resuming;

  assert.deepEqual(state, { status: 'exited', exitCode: 0 });
  assert.ok(Date.now() - started < 30000, 'the wait should end when the game exits');
});

test('get_debug_state reads the variables of another stack frame', async (t) => {
  const { debug, json, call, hitBreakpoint } = await setup(t);
  debug.answer('get_stack_dump', debuggerFrame('stack_dump', THREAD_ID, [6, 'res://player.gd', 12, '_process', 'res://main.gd', 4, 'tick']));
  await hitBreakpoint();
  debug.answer('get_stack_frame_vars', debuggerFrame('stack_frame_vars', THREAD_ID, [1]), debuggerFrame('stack_frame_var', THREAD_ID, ['ticks', 0, 2, 7, '']));

  const caller = await json('get_debug_state', { frame: 1 });
  const outOfRange = await call('get_debug_state', { frame: 2 });

  assert.equal(caller.pause.frame, 1);
  assert.deepEqual(caller.pause.variables, { locals: { ticks: 7 }, members: {} });
  assert.equal(outOfRange.content.at(-1).text, 'frame must be between 0 and 1');
});

test('get_debug_state and pause_game read the variables of an existing pause again', async (t) => {
  const { debug, json, hitBreakpoint } = await setup(t);
  await hitBreakpoint();
  // As after set_node_property changed a member while the game was paused
  debug.answer('get_stack_frame_vars', debuggerFrame('stack_frame_vars', THREAD_ID, [1]), debuggerFrame('stack_frame_var', THREAD_ID, ['speed', 1, 2, 55, '']));

  const state = await json('get_debug_state');
  const paused = await json('pause_game');

  assert.deepEqual(state.pause.variables, { locals: {}, members: { speed: 55 } });
  assert.deepEqual(paused.pause.variables, { locals: {}, members: { speed: 55 } });
});

test('concurrent reads of different stack frames each get their own variables', async (t) => {
  const { debug, json, hitBreakpoint } = await setup(t);
  debug.answer('get_stack_dump', debuggerFrame('stack_dump', THREAD_ID, [9, 'res://player.gd', 12, '_process', 'res://main.gd', 4, 'tick', 'res://main.gd', 2, '_ready']));
  await hitBreakpoint();
  debug.answer('get_stack_frame_vars', ([frame]) => [
    debuggerFrame('stack_frame_vars', THREAD_ID, [1]),
    debuggerFrame('stack_frame_var', THREAD_ID, ['frame', 0, 2, frame, '']),
  ]);

  const [first, second] = await Promise.all([json('get_debug_state', { frame: 1 }), json('get_debug_state', { frame: 2 })]);

  assert.deepEqual(first.pause.variables, { locals: { frame: 1 }, members: {} });
  assert.deepEqual(second.pause.variables, { locals: { frame: 2 }, members: {} });
});

test('a pause whose variables cannot be read still reports its stack', async (t) => {
  const { debug, json } = await setup(t);
  debug.answer('get_stack_frame_vars');

  const waiting = json('get_debug_state', { waitMs: 5000 });
  debug.send(frames.debug_enter_breakpoint);
  const state = await waiting;

  assert.deepEqual(state.pause.stack, [{ file: 'res://player.gd', line: lines.breakpoint, function: '_process' }]);
  assert.equal(state.pause.variables, null);
});

test('evaluate returns the value in the paused frame', async (t) => {
  const { json, hitBreakpoint, messages } = await setup(t);
  await hitBreakpoint();

  const result = await json('evaluate', { expression: 'direction * speed' });

  assert.deepEqual(result, { expression: 'direction * speed', frame: 0, value: [0, 0] });
  assert.deepEqual(messages('evaluate'), [['direction * speed', 0]]);
});

test('evaluate rejects a frame outside the stack without sending it', async (t) => {
  const { call, json, hitBreakpoint, messages } = await setup(t);
  await hitBreakpoint();

  const reply = await call('evaluate', { expression: 'speed', frame: 1 });

  assert.equal(reply.isError, true);
  assert.equal(reply.content.at(-1).text, 'frame must be between 0 and 0');
  assert.deepEqual(messages('evaluate'), []);
  assert.equal((await json('get_debug_state')).status, 'paused');
});

test('evaluate fails as soon as Godot resumes the game instead of answering', async (t) => {
  const { debug, call, json, hitBreakpoint } = await setup(t);
  await hitBreakpoint();
  // What Godot does for a frame without a script instance, e.g. in a static function
  debug.answer('evaluate', frames.debug_exit);

  const reply = await call('evaluate', { expression: 'speed' });

  assert.equal(reply.isError, true);
  assert.equal(reply.content[0].text, 'Godot did not evaluate the expression: The game resumed without answering');
  assert.equal((await json('get_debug_state')).status, 'running');
});

test('a pending request fails as soon as the game disconnects', async (t) => {
  const { debug, call, hitBreakpoint } = await setup(t);
  await hitBreakpoint();
  debug.answer('evaluate');

  const evaluating = call('evaluate', { expression: 'speed' });
  await debug.waitFor('evaluate');
  debug.close();
  const reply = await evaluating;

  assert.equal(reply.isError, true);
  assert.match(reply.content.at(-2).text, /disconnected/);
});

test('a reply that arrives after its request timed out does not answer the next request', async (t) => {
  const evaluationReturn = (expression, value) => debuggerFrame('evaluation_return', THREAD_ID, [expression, 0, 2, value, '']);
  const { debug, call, json, hitBreakpoint } = await setup(t);
  await hitBreakpoint();
  debug.answer('evaluate', ([expression]) => (expression === 'late' ? [] : [evaluationReturn(expression, 2)]));

  const timedOut = await call('evaluate', { expression: 'late' });
  const next = json('evaluate', { expression: 'speed' });
  debug.send(evaluationReturn('late', 1));

  assert.equal(timedOut.isError, true);
  assert.deepEqual(await next, { expression: 'speed', frame: 0, value: 2 });
});

test('version limits: evaluate needs Godot 4.4, stepping out 4.6', async (t) => {
  const old = await setup(t, { version: '4.3.stable.official' });
  await old.hitBreakpoint();
  const withoutOut = await setup(t, { version: '4.5.1.stable.official' });
  await withoutOut.hitBreakpoint();

  assert.equal((await old.call('evaluate', { expression: '1' })).content.at(-2).text, 'Godot 4.4 or later is needed for evaluating expressions; this is 4.3.stable.official');
  assert.equal((await withoutOut.call('resume_game', { action: 'out' })).content.at(-2).text, 'Stepping out needs Godot 4.6 or later');
});

test('breakOnError pauses on errors: 4.5+ stops ignoring error breaks, 4.4 stops answering them', async (t) => {
  for (const version of ['4.7.2.stable.official', '4.4.1.stable.official']) {
    const { debug, json, messages } = await setup(t, { version, breakOnError: true });
    debug.answer('get_stack_dump', debuggerFrame('stack_dump', THREAD_ID, [3, 'res://main.gd', lines.script_error_ready, '_ready']));

    const waiting = json('get_debug_state', { waitMs: 2000 });
    debug.send(frames.debug_enter_error);
    const state = await waiting;

    assert.equal(state.pause.reason, 'error', version);
    assert.equal(state.pause.error, "Invalid call. Nonexistent function 'foo' in base 'Nil'.");
    assert.deepEqual(messages('continue'), [], version);
    assert.deepEqual(messages('set_ignore_error_breaks'), version.startsWith('4.7') ? [[false]] : []);
  }
});

test('while the game is paused, every tool reply starts with a note', async (t) => {
  const { call, hitBreakpoint } = await setup(t);
  await hitBreakpoint();

  const reply = await call('list_breakpoints');

  assert.equal(reply.content[0].text, PAUSED_NOTE);
});

test('stop_project ends a paused game', async (t) => {
  const { json, hitBreakpoint } = await setup(t);
  await hitBreakpoint();

  const stopped = await json('stop_project');
  const state = await json('get_debug_state');

  assert.equal(stopped.running, false);
  assert.deepEqual(state, { status: 'exited', exitCode: null });
});

test('pause_game turns breakpoint skipping off, then pauses', async (t) => {
  const { debug, json, messages } = await setup(t);
  debug.answer('break', frames.debug_enter_pause);
  debug.answer('get_stack_dump', frames.stack_dump_empty);

  const state = await json('pause_game');

  assert.deepEqual(state, { status: 'paused', pause: { reason: 'pause', stack: [], frame: 0, variables: null } });
  const names = debug.received.map(([name]) => name);
  assert.ok(names.lastIndexOf('set_skip_breakpoints') < names.indexOf('break'));
  assert.deepEqual(messages('set_skip_breakpoints').at(-1), [false]);
});

test('resume_game refuses when the game is not paused', async (t) => {
  const { call } = await setup(t);

  const reply = await call('resume_game');

  assert.equal(reply.content[0].text, 'The game is not paused');
});
