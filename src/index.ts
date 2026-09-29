#!/usr/bin/env node
/**
 * Entry point: serves the Godot MCP server over stdio.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { GodotServer } from './server.js';

const server = new GodotServer();

// Stop the running game and exit, however the client ends the session
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// The SDK's stdio transport does not report the client closing stdin
process.stdin.on('end', shutdown);

try {
  await server.connect(new StdioServerTransport());
  console.error('Godot MCP server running on stdio');
} catch (error: unknown) {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('[SERVER] Failed to start:', errorMessage);
  process.exit(1);
}
