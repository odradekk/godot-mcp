// Breakpoints, pausing, stepping and evaluate, with the test playing the game's side of the
// debugger protocol using frames recorded from Godot 4.7.2 on the #17 scenario (see
// scripts/record-debugger-fixtures.mjs, run 4).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { connect, debuggerFixtures, debuggerFrame, fakeLauncher, makeProject, text } from './harness.mjs';

const GODOT = '/opt/godot';
const { frames, lines } = debuggerFixtures();
const THREAD_ID = 1;
const PAUSED_NOTE = `Game paused at res://player.gd:${lines.breakpoint} (_process); use resume_game to continue`;
const frameVars = ['stack_frame_vars', 'stack_frame_var_delta', 'stack_frame_var_step', 'stack_frame_var_self', 'stack_frame_var_speed', 'stack_frame_var_velocity', 'stack_frame_var_direction'].map((key) => frames[key]);

const godotReporting = (version) => (file, args) => {
  if (args[0] === '--version') return { stdout: `${version}\n` };
  throw new Error(`Unexpected Godot call: ${args.join(' ')}`);
};

async function setup(t, { version = '4.7.2.stable.official', breakOnError = false, before } = {}) {
  const launcher = fakeLauncher(godotReporting(version));
  const { client, close } = await connect({ godotPath: GODOT, launcher, stopTimeoutMs: 200 });
  t.after(close);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  // The last content item is the tool's own reply; a pause note may come first
  const json = async (name, args) => JSON.parse((await call(name, args)).content.at(-1).text);
  await before?.(call);

  await call('run_project', { projectPath: await makeProject(t), breakOnError });
  const game = launcher.children.at(-1);
  const debug = await game.connectDebugger();
  debug.answer('get_stack_dump', frames.stack_dump);
  debug.answer('get_stack_frame_vars', ...frameVars);
  debug.answer('evaluate', frames.evaluation_return);
  debug.send(frames.set_pid);
  await debug.waitFor('set_skip_breakpoints');

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
  await new Promise((resolve) => setTimeout(resolve, 50));

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
  setTimeout(() => game.exit(0), 50);
  const state = await json('resume_game', { waitMs: 5000 });

  assert.deepEqual(state, { status: 'exited', exitCode: 0 });
  assert.ok(Date.now() - started < 2000);
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

test('evaluate returns the value in the paused frame', async (t) => {
  const { json, hitBreakpoint, messages } = await setup(t);
  await hitBreakpoint();

  const result = await json('evaluate', { expression: 'direction * speed' });

  assert.deepEqual(result, { expression: 'direction * speed', frame: 0, value: [0, 0] });
  assert.deepEqual(messages('evaluate'), [['direction * speed', 0]]);
});

test('version limits: evaluate needs Godot 4.4, stepping out 4.6', async (t) => {
  const old = await setup(t, { version: '4.3.stable.official' });
  await old.hitBreakpoint();
  const withoutOut = await setup(t, { version: '4.5.1.stable.official' });
  await withoutOut.hitBreakpoint();

  assert.equal((await old.call('evaluate', { expression: '1' })).content.at(-1).text, 'Evaluating expressions needs Godot 4.4 or later');
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
