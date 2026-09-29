// The framing of the remote debugger stream: whole frames come out however the bytes arrive.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FrameReader, encodeFrame } from '../build/debugger-frames.js';
import { decodeVariant } from '../build/variant.js';

const messages = [
  ['set_pid', 1, [4242]],
  ['error', 1, ['a message', 'a longer message that makes this frame bigger than the length prefix', true]],
  ['debug_exit', 1, []],
];
const frames = messages.map(([name, threadId, data]) => encodeFrame(name, threadId, data));
const decode = (frame) => decodeVariant(frame, 4)[0];

test('frames arriving one byte at a time come out whole and in order', () => {
  const reader = new FrameReader();
  const out = [];

  for (const byte of Buffer.concat(frames)) out.push(...reader.push(Buffer.from([byte])));

  assert.deepEqual(out, frames);
  assert.deepEqual(out.map(decode), messages);
});

test('several frames in one chunk come out separately', () => {
  const reader = new FrameReader();

  const out = reader.push(Buffer.concat(frames));

  assert.deepEqual(out, frames);
  assert.deepEqual(out.map(decode), messages);
});

test('a frame split inside its length prefix and one split inside its body are held until complete', () => {
  const reader = new FrameReader();
  const all = Buffer.concat(frames.slice(0, 2));
  const inBody = frames[0].length + 10;

  assert.deepEqual(reader.push(all.subarray(0, 2)), []);
  assert.deepEqual(reader.push(all.subarray(2, inBody)), [frames[0]]);
  assert.deepEqual(reader.push(all.subarray(inBody)), [frames[1]]);
});
