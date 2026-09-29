#!/usr/bin/env node
/**
 * Entry point: serves the Godot MCP server over stdio.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { GodotServer } from './server.js';

const server = new GodotServer();

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});

try {
  await server.connect(new StdioServerTransport());
  console.error('Godot MCP server running on stdio');
} catch (error: unknown) {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('[SERVER] Failed to start:', errorMessage);
  process.exit(1);
}
