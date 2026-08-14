#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();

try {
  await server.connect(transport);
} catch (error) {
  process.stderr.write(`TodoMCP failed to start: ${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
}
