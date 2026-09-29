/**
 * Framing of Godot's remote debugger protocol: each message is a Variant array
 * [name, thread_id, data], preceded by its length as a 32-bit little-endian integer.
 */

import { encodeVariant } from './variant.js';

/** A message as a frame, length prefix included */
export function encodeFrame(name: string, threadId: number | bigint, data: unknown[]): Buffer {
  const body = encodeVariant([name, threadId, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
}

/**
 * Splits a byte stream into frames, length prefix included. Received chunks are kept as they are
 * and joined once a whole frame has arrived, so a large message is copied once, not per chunk.
 */
export class FrameReader {
  private chunks: Buffer[] = [];
  private size = 0;

  /** Add received bytes; returns the frames they complete */
  push(chunk: Buffer): Buffer[] {
    this.chunks.push(chunk);
    this.size += chunk.length;
    const frames: Buffer[] = [];
    while (this.size >= 4) {
      if (this.chunks[0].length < 4) this.join();
      const frameLength = 4 + this.chunks[0].readUInt32LE(0);
      if (this.size < frameLength) break;
      this.join();
      const data = this.chunks[0];
      frames.push(data.subarray(0, frameLength));
      this.chunks = data.length > frameLength ? [data.subarray(frameLength)] : [];
      this.size -= frameLength;
    }
    return frames;
  }

  private join() {
    this.chunks = [Buffer.concat(this.chunks)];
  }
}
