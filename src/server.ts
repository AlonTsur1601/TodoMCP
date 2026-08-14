import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ApplyAdviceInputSchema,
  AuditCompletionInputSchema,
  CreatePlanInputSchema,
  PlanReferenceSchema,
  RequestAnalysisInputSchema,
  RevisePlanInputSchema,
  StartTaskInputSchema,
} from "./schemas.js";
import { TodoService } from "./service.js";

const INSTRUCTIONS = `For multi-part work, call todo_analyze_request before planning. Every actionable source unit must map to an active requirement and an atomic task. Use direct mode only for 1-3 genuinely small independent actions. Never claim a task is complete until todo_audit_completion returns approved=true, and never claim the whole request is complete until todo_close_plan succeeds. Delegation recommendations are advisory and capped at 3 agents.

When countdown_advise_work is available, pass it todo_get_execution_candidates and return its ranking through todo_apply_execution_advice. Countdown advice may reorder ready tasks but never bypass dependencies, scope, or verification. Continue normally when CountdownMCP is unavailable. Do not expose internal plan lists for direct mode unless useful to the user.`;

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
    description: "Use before planning multi-part work. Deterministically identifies source clauses, constraints, success criteria, and whether a visible plan is warranted.",
    inputSchema: RequestAnalysisInputSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ request }) => toolResult(service.analyze(request), "Request analyzed into stable source units."));

  server.registerTool("todo_create_plan", {
    title: "Create and validate a work contract",
    description: "Submit a direct work contract or atomic plan. Rejected submissions remain drafts and cannot execute.",
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
    description: "Audit every acceptance criterion and the quality of its verification. Only approved evidence can complete a task.",
    inputSchema: AuditCompletionInputSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceRoot, planId, taskId, summary, evidence, unresolvedIssues }) => toolResult(
    await service.auditCompletion(workspaceRoot, planId, taskId, summary, evidence, unresolvedIssues),
    "Completion evidence audited.",
  ));

  server.registerTool("todo_close_plan", {
    title: "Close a fully verified plan",
    description: "Close a plan only after every active requirement and task has approved evidence. There is no force-complete path.",
    inputSchema: PlanReferenceSchema,
    outputSchema: GenericOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceRoot, planId }) => toolResult(await service.closePlan(workspaceRoot, planId), "Plan closure checked."));

  return server;
}

export { INSTRUCTIONS };
