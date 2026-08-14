import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const serverPath = fileURLToPath(new URL("../dist/src/index.js", import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, TODO_MCP_DATA_DIR: fileURLToPath(new URL("../.smoke-data", import.meta.url)) },
  stderr: "pipe",
});
const client = new Client({ name: "todo-mcp-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const serverVersion = client.getServerVersion();
  if (serverVersion?.version !== manifest.version) {
    throw new Error(`Server version ${serverVersion?.version ?? "missing"} does not match package version ${manifest.version}.`);
  }
  if (!client.getInstructions()?.includes("todo_audit_completion")) throw new Error("Server instructions are missing the completion gate.");
  const tools = await client.listTools();
  const expected = [
    "todo_analyze_request",
    "todo_create_plan",
    "todo_revise_plan",
    "todo_get_plan",
    "todo_start_task",
    "todo_recommend_delegation",
    "todo_get_execution_candidates",
    "todo_apply_execution_advice",
    "todo_audit_completion",
    "todo_audit_result",
    "todo_close_plan",
  ];
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of expected) {
    if (!names.has(name)) throw new Error(`Missing tool: ${name}`);
  }
  const result = await client.callTool({ name: "todo_analyze_request", arguments: { request: "Update the README and run its tests." } });
  if (result.isError) throw new Error("Analysis tool returned an error.");
  process.stdout.write(`TODO_MCP_SMOKE_PASS tools=${tools.tools.length}\n`);
} finally {
  await client.close();
  await transport.close();
}
