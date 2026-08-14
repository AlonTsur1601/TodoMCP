import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ApplyAdviceInputSchema,
  AuditCompletionInputSchema,
  AuditResultInputSchema,
  CreatePlanInputSchema,
  PlanReferenceSchema,
  RequestAnalysisInputSchema,
  RevisePlanInputSchema,
  StartTaskInputSchema,
} from "./schemas.js";
import { TodoService } from "./service.js";

const INSTRUCTIONS = `Minimize TodoMCP tool calls. For an obviously small, clear, deterministic task, do the work independently and make zero TodoMCP calls: do not analyze it, create a plan, start a task, or audit an outcome that is directly observable. A simple exact edit such as replacing one known line is deterministic and needs no TodoMCP validation.

For small work with meaningful completion uncertainty, still work independently without creating TodoMCP state. At the end, make at most one call to todo_audit_result with the concrete uncertainty reasons and evidence. If there is no meaningful uncertainty, do not call it.

For genuinely multi-step, dependent, risky, or broad work, call todo_analyze_request once and create an atomic plan. Every actionable source unit must map to an active requirement and task. Avoid todo_get_plan unless recovering state or resolving a real ambiguity. todo_audit_completion can auto-start a ready task, so omit separate todo_start_task calls unless ownership, scheduling, or explicit state control requires them. Close the plan once after the final approved audit. Delegation recommendations are advisory and capped at 3 agents.

Use CountdownMCP coordination only when usage-aware scheduling can materially change which ready task should run. Do not invoke the three-step Countdown exchange for small work or repeatedly without a meaningful state or usage change. Countdown advice may reorder ready tasks but never bypass dependencies, scope, or verification. Continue normally when CountdownMCP is unavailable.`;

function toolResult(result: unknown, message: string) {
  return {
    structuredContent: { result },
    content: [{ type: "text" as const, text: message }],
  };
}

const GenericOutputSchema = { result: z.unknown() };

export function createServer(service = new TodoService()): McpServer {
  const server = new McpServer(
    { name: "todo_mcp", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool("todo_analyze_request", {
    title: "Analyze request into source units",
    description: "Use once only when work may require a plan. Do not call for obviously small deterministic work. Identifies source clauses, uncertainty, and whether Codex should work independently or create a plan.",
    inputSchema: RequestAnalysisInputSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ request }) => toolResult(service.analyze(request), "Request analyzed into stable source units."));

  server.registerTool("todo_create_plan", {
    title: "Create and validate a work contract",
    description: "Create an atomic plan for genuinely complex work. Small work should run independently; direct contracts remain supported for compatibility.",
    inputSchema: CreatePlanInputSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (input) => toolResult(await service.createPlan(input), "Plan candidate validated and stored."));

  server.registerTool("todo_revise_plan", {
    title: "Revise a plan",
    description: "Replace a draft or active plan while retaining history. Changed completion contracts invalidate prior completion.",
    inputSchema: RevisePlanInputSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceRoot, planId, revisionReason, ...definition }) => toolResult(
    await service.revisePlan(workspaceRoot, planId, revisionReason, definition),
    "Plan revision validated and stored.",
  ));

  server.registerTool("todo_get_plan", {
    title: "Get plan state",
    description: "Read the plan, coverage, ready and blocked tasks, verification history, and next task.",
    inputSchema: PlanReferenceSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ workspaceRoot, planId }) => toolResult(await service.getPlan(workspaceRoot, planId), "Plan state loaded."));

  server.registerTool("todo_start_task", {
    title: "Start a ready task",
    description: "Start an atomic task only when all dependencies are complete.",
    inputSchema: StartTaskInputSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceRoot, planId, taskId, owner }) => toolResult(
    await service.startTask(workspaceRoot, planId, taskId, owner),
    "Task started.",
  ));

  server.registerTool("todo_recommend_delegation", {
    title: "Recommend bounded delegation",
    description: "Recommend zero to three additional agents only for independent, substantial, low-overlap ready tasks. Does not create agents.",
    inputSchema: PlanReferenceSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ workspaceRoot, planId }) => toolResult(
    await service.recommendDelegation(workspaceRoot, planId),
    "Delegation recommendation calculated.",
  ));

  server.registerTool("todo_get_execution_candidates", {
    title: "Get WorkCandidate v1 tasks",
    description: "Return ready tasks in the neutral WorkCandidate v1 shape accepted by CountdownMCP. Works without CountdownMCP.",
    inputSchema: PlanReferenceSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ workspaceRoot, planId }) => toolResult(
    await service.getExecutionCandidates(workspaceRoot, planId),
    "Ready execution candidates returned.",
  ));

  server.registerTool("todo_apply_execution_advice", {
    title: "Apply external execution advice",
    description: "Apply a neutral advisor ranking to ready tasks. Unknown or blocked task ids are rejected; dependencies are never bypassed.",
    inputSchema: ApplyAdviceInputSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceRoot, planId, advice }) => toolResult(
    await service.applyExecutionAdvice(workspaceRoot, planId, {
      recommendedNow: advice.recommendedNow,
      deferUntilReset: advice.deferUntilReset,
      executionOrder: advice.executionOrder,
      source: advice.source,
      ...(advice.checkpoint ? { checkpoint: advice.checkpoint } : {}),
    }),
    "Execution advice validated and applied.",
  ));

  server.registerTool("todo_audit_completion", {
    title: "Audit task completion evidence",
    description: "Audit a planned task. A ready pending task is auto-started to avoid a separate start call; the result reports when the plan is ready to close.",
    inputSchema: AuditCompletionInputSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceRoot, planId, taskId, summary, evidence, unresolvedIssues }) => toolResult(
    await service.auditCompletion(workspaceRoot, planId, taskId, summary, evidence, unresolvedIssues),
    "Completion evidence audited.",
  ));

  server.registerTool("todo_audit_result", {
    title: "Audit an uncertain independent result",
    description: "Use at most once after small independent work, and only when completion has meaningful uncertainty. Creates no plan or task state; deterministic edits are skipped.",
    inputSchema: AuditResultInputSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ workspaceRoot, originalRequest, summary, acceptanceCriteria, evidence, uncertaintyReasons, unresolvedIssues }) => toolResult(
    await service.auditResult(workspaceRoot, originalRequest, summary, acceptanceCriteria, evidence, uncertaintyReasons, unresolvedIssues),
    "Independent completion evidence assessed.",
  ));

  server.registerTool("todo_close_plan", {
    title: "Close a fully verified plan",
    description: "Close a fully verified plan once after the final approved audit. There is no force-complete path.",
    inputSchema: PlanReferenceSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceRoot, planId }) => toolResult(await service.closePlan(workspaceRoot, planId), "Plan closure checked."));

  return server;
}

export { INSTRUCTIONS };
