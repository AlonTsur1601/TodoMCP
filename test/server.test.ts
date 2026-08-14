import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { TodoService } from "../src/service.js";
import { PlanStore } from "../src/store.js";

test("MCP exposes eleven namespaced tools with accurate annotations and strict input", async () => {
  const root = await mkdtemp(join(tmpdir(), "todo-mcp-server-test-"));
  const server = createServer(new TodoService(new PlanStore(join(root, "data"))));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "todo-test", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.match(client.getInstructions() ?? "", /zero TodoMCP calls/);
    assert.match(client.getInstructions() ?? "", /at most one call to todo_audit_result/);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 11);
    assert.ok(listed.tools.every((tool) => tool.name.startsWith("todo_")));
    const analyze = listed.tools.find((tool) => tool.name === "todo_analyze_request")!;
    const create = listed.tools.find((tool) => tool.name === "todo_create_plan")!;
    const independentAudit = listed.tools.find((tool) => tool.name === "todo_audit_result")!;
    assert.equal(analyze.annotations?.readOnlyHint, true);
    assert.equal(create.annotations?.readOnlyHint, false);
    assert.equal(independentAudit.annotations?.readOnlyHint, true);
    assert.ok(listed.tools.every((tool) => tool.annotations?.destructiveHint === false && tool.annotations?.openWorldHint === false));

    const invalid = await client.callTool({ name: "todo_analyze_request", arguments: { request: "", extra: true } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("independent completion audit skips deterministic work and audits uncertain work without a plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "todo-mcp-independent-audit-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const server = createServer(new TodoService(new PlanStore(join(root, "data"))));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "todo-independent-audit", version: "1.0.0" });
  const criterion = {
    id: "criterion-1",
    text: "The public result behaves correctly",
    requiredEvidence: "unit",
    observableInterface: true,
    requiresBoundaryCases: true,
  };
  const evidence = {
    criterionId: "criterion-1",
    method: "unit",
    target: "The public result",
    input: "Normal and invalid boundary inputs",
    expected: "Normal input succeeds and invalid input is rejected",
    observed: "Both named assertions matched the expected behavior",
    rawOutput: "tests 2, pass 2, fail 0; public result and rejection assertions passed",
    failureSensitivity: "Changing the result or accepting invalid input makes a named assertion fail",
    observesPublicInterface: true,
    boundaryCases: ["invalid input is rejected"],
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const skipped = await client.callTool({ name: "todo_audit_result", arguments: {
      workspaceRoot: workspace,
      originalRequest: "Replace line 4 with the exact requested text.",
      summary: "The exact line was replaced.",
      acceptanceCriteria: [criterion],
      evidence: [evidence],
      uncertaintyReasons: [],
      unresolvedIssues: [],
    } });
    assert.equal((skipped.structuredContent as { result: { auditPerformed: boolean; approved: null } }).result.auditPerformed, false);

    const audited = await client.callTool({ name: "todo_audit_result", arguments: {
      workspaceRoot: workspace,
      originalRequest: "Fix the runtime bug.",
      summary: "Runtime behavior was verified.",
      acceptanceCriteria: [criterion],
      evidence: [evidence],
      uncertaintyReasons: ["Runtime behavior could differ from the edited internal state."],
      unresolvedIssues: [],
    } });
    const result = (audited.structuredContent as { result: { auditPerformed: boolean; approved: boolean } }).result;
    assert.equal(result.auditPerformed, true);
    assert.equal(result.approved, true);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP completes a direct work contract only through audited evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "todo-mcp-flow-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const server = createServer(new TodoService(new PlanStore(join(root, "data"))));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "todo-flow-test", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const analyzed = await client.callTool({ name: "todo_analyze_request", arguments: { request: "Create the result." } });
    const analysis = (analyzed.structuredContent as { result: { sourceUnits: Array<{ id: string; text: string }> } }).result;
    const source = analysis.sourceUnits[0]!;
    const task = {
      id: "task-1", title: "Produce the requested result", objective: "Create one bounded public result",
      deliverables: ["The requested result"], requirementIds: ["req-1"], dependencies: [], expectedFiles: [],
      acceptanceCriteria: [{ id: "criterion-1", text: "The public result is correct", requiredEvidence: "unit", observableInterface: true, requiresBoundaryCases: true }],
      priority: 5, estimatedMinutes: 10, risk: "low", parallelizable: false, needsUserInput: false,
      canContinueWithoutNewMessage: true, checkpointable: true,
    };
    const created = await client.callTool({ name: "todo_create_plan", arguments: {
      workspaceRoot: workspace, originalRequest: "Create the result.", mode: "direct",
      requirements: [{ id: "req-1", text: source.text, sourceUnitIds: [source.id], disposition: "active" }],
      tasks: [task],
    } });
    const creation = (created.structuredContent as { result: { planId: string; accepted: boolean } }).result;
    assert.equal(creation.accepted, true);
    await client.callTool({ name: "todo_start_task", arguments: { workspaceRoot: workspace, planId: creation.planId, taskId: "task-1" } });
    const audited = await client.callTool({ name: "todo_audit_completion", arguments: {
      workspaceRoot: workspace, planId: creation.planId, taskId: "task-1", summary: "Verified",
      unresolvedIssues: [], evidence: [{
        criterionId: "criterion-1", method: "unit", target: "Public result", input: "normal and boundary inputs",
        expected: "normal output succeeds and boundary input is rejected",
        observed: "both named public assertions matched", rawOutput: "tests 2, pass 2, fail 0 with both named assertions",
        failureSensitivity: "Changing either public result causes the corresponding assertion to fail",
        observesPublicInterface: true, boundaryCases: ["boundary input rejected"],
      }],
    } });
    assert.equal((audited.structuredContent as { result: { approved: boolean } }).result.approved, true);
    const closed = await client.callTool({ name: "todo_close_plan", arguments: { workspaceRoot: workspace, planId: creation.planId } });
    assert.equal((closed.structuredContent as { result: { closed: boolean } }).result.closed, true);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
