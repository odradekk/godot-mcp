// The child_process launcher, exercised with Node itself standing in for Godot.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodeLauncher } from '../build/godot-launcher.js';

const node = process.execPath;

test('a non-zero exit resolves with the exit code and output', async () => {
  const result = await nodeLauncher.run(node, ['-e', 'console.log("out"); console.error("err"); process.exit(3)']);

  assert.deepEqual(result, { stdout: 'out\n', stderr: 'err\n', exitCode: 3 });
});

test('a timeout rejects with a message naming the limit', async () => {
  await assert.rejects(
    nodeLauncher.run(node, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 }),
    /timed out after 0\.2 s/
  );
});

test('output over the limit rejects with a message naming the limit', async () => {
  await assert.rejects(
    nodeLauncher.run(node, ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'], { maxBufferBytes: 1024 * 1024 }),
    /output exceeded 1 MiB/
  );
});

test('a missing executable rejects', async () => {
  await assert.rejects(nodeLauncher.run('/no/such/godot', ['--version']), { code: 'ENOENT' });
});
