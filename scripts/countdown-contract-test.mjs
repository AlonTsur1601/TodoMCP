import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer as createTodoServer } from "../dist/src/server.js";
import { TodoService } from "../dist/src/service.js";
import { PlanStore } from "../dist/src/store.js";

const countdownEntry = resolve(process.argv[2] ?? "../CountdownMCP/dist/server.js");
const { createServer: createCountdownServer } = await import(pathToFileURL(countdownEntry).href);
const root = await mkdtemp(join(tmpdir(), "todo-countdown-contract-"));
const workspace = join(root, "workspace");
await mkdir(workspace);

const usage = {
  planType: "plus", usedPercent: 85, remainingPercent: 15, effectiveLimitId: "codex",
  buckets: { codex: {
    limitId: "codex", limitName: "Codex", planType: "plus",
    primary: { usedPercent: 85, remainingPercent: 15, durationMinutes: 300, resetsAt: null, resetsAtIso: null, secondsUntilReset: null },
    secondary: null, effectiveWindow: "primary", usedPercent: 85, remainingPercent: 15,
    credits: null, individualLimit: null, spendControlReached: false, rateLimitReachedType: null,
  } },
  credits: null, spendControlReached: false, rateLimitReachedType: null, resetCreditsAvailable: null,
  source: "app_server", sampledAt: new Date().toISOString(), sourceTimestamp: null, stale: false,
};
const provider = { getUsage: async () => usage, close: () => undefined };
const todoServer = createTodoServer(new TodoService(new PlanStore(join(root, "data"))));
const countdownBundle = createCountdownServer(provider);
const [todoClientTransport, todoServerTransport] = InMemoryTransport.createLinkedPair();
const [countdownClientTransport, countdownServerTransport] = InMemoryTransport.createLinkedPair();
const todoClient = new Client({ name: "contract-todo", version: "1.0.0" });
const countdownClient = new Client({ name: "contract-countdown", version: "1.0.0" });

try {
  await todoServer.connect(todoServerTransport);
  await countdownBundle.server.connect(countdownServerTransport);
  await todoClient.connect(todoClientTransport);
  await countdownClient.connect(countdownClientTransport);
  const request = "First action. Second action. Third action. Fourth action.";
  const analyzed = await todoClient.callTool({ name: "todo_analyze_request", arguments: { request } });
  const units = analyzed.structuredContent.result.sourceUnits;
  const requirements = units.map((unit, index) => ({ id: `req-${index + 1}`, text: unit.text, sourceUnitIds: [unit.id], disposition: "active" }));
  const tasks = requirements.map((requirement, index) => ({
    id: `task-${index + 1}`, title: `Produce result ${index + 1}`, objective: `Create bounded result ${index + 1}`,
    deliverables: [`result-${index + 1}`], requirementIds: [requirement.id], dependencies: [], expectedFiles: [],
    acceptanceCriteria: [{ id: `criterion-${index + 1}`, text: "Result is correct", requiredEvidence: "unit", observableInterface: false, requiresBoundaryCases: false }],
    priority: 5 - index, estimatedMinutes: 15 + index * 10, risk: "low", parallelizable: true,
    needsUserInput: false, canContinueWithoutNewMessage: true, checkpointable: true,
  }));
  const created = await todoClient.callTool({ name: "todo_create_plan", arguments: { workspaceRoot: workspace, originalRequest: request, mode: "plan", requirements, tasks } });
  const planId = created.structuredContent.result.planId;
  const candidateResult = await todoClient.callTool({ name: "todo_get_execution_candidates", arguments: { workspaceRoot: workspace, planId } });
  const candidates = candidateResult.structuredContent.result;
  const adviceResult = await countdownClient.callTool({ name: "countdown_advise_work", arguments: candidates });
  if (adviceResult.isError) throw new Error("CountdownMCP rejected TodoMCP WorkCandidate.v1 output.");
  const applied = await todoClient.callTool({
    name: "todo_apply_execution_advice",
    arguments: { workspaceRoot: workspace, planId, advice: adviceResult.structuredContent },
  });
  if (applied.isError || !applied.structuredContent.result.applied) throw new Error("TodoMCP rejected CountdownMCP advice output.");
  process.stdout.write(`TODO_COUNTDOWN_CONTRACT_PASS candidates=${candidates.tasks.length}\n`);
} finally {
  await todoClient.close();
  await countdownClient.close();
  await todoServer.close();
  countdownBundle.close();
  await countdownBundle.server.close();
  await rm(root, { recursive: true, force: true });
}
