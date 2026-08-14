import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PlanDefinitionInput, TaskInput } from "../src/schemas.js";
import { TodoService } from "../src/service.js";
import { PlanStore } from "../src/store.js";

async function environment() {
  const root = await mkdtemp(join(tmpdir(), "todo-mcp-test-"));
  const workspace = join(root, "workspace עברית");
  const data = join(root, "data");
  await mkdir(workspace, { recursive: true });
  return { root, workspace, service: new TodoService(new PlanStore(data)), data };
}

function task(id: string, requirementId: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id,
    title: `Produce ${id}`,
    objective: `Create and verify the bounded deliverable for ${id}`,
    deliverables: [`${id} deliverable`],
    requirementIds: [requirementId],
    dependencies: [],
    expectedFiles: [`src/${id}.ts`],
    acceptanceCriteria: [{
      id: `${id}-criterion`,
      text: `${id} behaves correctly`,
      requiredEvidence: "unit",
      observableInterface: true,
      requiresBoundaryCases: true,
    }],
    priority: 3,
    estimatedMinutes: 45,
    risk: "low",
    parallelizable: true,
    needsUserInput: false,
    canContinueWithoutNewMessage: true,
    checkpointable: true,
    ...overrides,
  };
}

function definition(service: TodoService, workspaceRoot: string, request: string, mode: "direct" | "plan" = "plan"): PlanDefinitionInput {
  const analysis = service.analyze(request);
  const requirements = analysis.sourceUnits.map((unit, index) => ({
    id: `req-${index + 1}`,
    text: unit.text,
    sourceUnitIds: [unit.id],
    disposition: "active" as const,
  }));
  return {
    workspaceRoot,
    originalRequest: request,
    mode,
    requirements,
    tasks: requirements.map((requirement, index) => task(`task-${index + 1}`, requirement.id)),
  };
}

function strongEvidence(criterionId: string) {
  return {
    criterionId,
    method: "unit" as const,
    target: "The public task API",
    input: "A valid input and an invalid boundary input",
    expected: "The valid input returns the expected value and the invalid input is rejected",
    observed: "Both assertions matched their explicit expected values",
    rawOutput: "tests 2, pass 2, fail 0; public API result and boundary rejection assertions both passed",
    failureSensitivity: "Changing the returned value or accepting the invalid input makes a named assertion fail",
    observesPublicInterface: true,
    boundaryCases: ["invalid input is rejected"],
  };
}

test("unmapped request parts reject a plan draft", async () => {
  const env = await environment();
  try {
    const candidate = definition(env.service, env.workspace, "Create the server. Write tests. Document it.", "direct");
    candidate.requirements.pop();
    candidate.tasks.pop();
    const result = await env.service.createPlan(candidate);
    assert.equal(result.accepted, false);
    assert.ok(result.issues.some((issue) => issue.includes("Source unit")));
    await assert.rejects(() => env.service.startTask(env.workspace, result.planId, "task-1"), /accepted active plans/);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("weak evidence is rejected and strong evidence completes direct work", async () => {
  const env = await environment();
  try {
    const candidate = definition(env.service, env.workspace, "Create the server.", "direct");
    const created = await env.service.createPlan(candidate);
    assert.equal(created.accepted, true);
    const weak = await env.service.auditCompletion(env.workspace, created.planId, "task-1", "done", [{
      criterionId: "task-1-criterion",
      method: "build",
      target: "compiler",
      input: "source",
      expected: "success",
      observed: "pass",
      rawOutput: "PASS",
      failureSensitivity: "none",
      observesPublicInterface: false,
      boundaryCases: [],
    }], []);
    assert.equal(weak.approved, false);
    assert.equal(weak.autoStarted, true);
    assert.ok(weak.issues.length >= 4);

    const strong = await env.service.auditCompletion(
      env.workspace,
      created.planId,
      "task-1",
      "verified through the public API",
      [strongEvidence("task-1-criterion")],
      [],
    );
    assert.equal(strong.approved, true);
    assert.equal(strong.autoStarted, false);
    assert.equal(strong.readyToClose, true);
    const closed = await env.service.closePlan(env.workspace, created.planId);
    assert.equal(closed.closed, true);

    const reloaded = new TodoService(new PlanStore(env.data));
    const plan = await reloaded.getPlan(env.workspace, created.planId);
    assert.equal(plan.status, "closed");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("dependencies and external advice cannot be bypassed", async () => {
  const env = await environment();
  try {
    const candidate = definition(env.service, env.workspace, "First action. Second action. Third action. Fourth action.");
    candidate.tasks[1]!.dependencies = ["task-1"];
    const created = await env.service.createPlan(candidate);
    assert.equal(created.accepted, true);
    await assert.rejects(() => env.service.startTask(env.workspace, created.planId, "task-2"), /blocked/);
    const candidates = await env.service.getExecutionCandidates(env.workspace, created.planId);
    assert.equal(candidates.schemaVersion, "WorkCandidate.v1");
    assert.ok(!candidates.tasks.some((item) => item.id === "task-2"));
    await assert.rejects(() => env.service.applyExecutionAdvice(env.workspace, created.planId, {
      recommendedNow: ["task-2"], deferUntilReset: [], executionOrder: ["task-2"], source: "countdown_mcp",
    }), /unknown or not ready/);
    const advice = await env.service.applyExecutionAdvice(env.workspace, created.planId, {
      recommendedNow: ["task-4"], deferUntilReset: [], executionOrder: ["task-4", "task-1"], source: "countdown_mcp",
    });
    assert.equal(advice.nextTaskId, "task-4");
    await assert.rejects(() => env.service.applyExecutionAdvice(env.workspace, created.planId, {
      recommendedNow: ["task-1", "task-1"], deferUntilReset: [], executionOrder: [], source: "malformed",
    }), /duplicate task ids/);

    const partial = await env.service.applyExecutionAdvice(env.workspace, created.planId, {
      recommendedNow: [], deferUntilReset: ["task-4"], executionOrder: [], source: "countdown_mcp",
    });
    assert.equal(partial.nextTaskId, "task-1");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("delegation is capped at three and excludes file overlap", async () => {
  const env = await environment();
  try {
    const candidate = definition(env.service, env.workspace, "One. Two. Three. Four. Five.");
    candidate.tasks[1]!.expectedFiles = candidate.tasks[0]!.expectedFiles;
    const created = await env.service.createPlan(candidate);
    assert.equal(created.accepted, true);
    const recommendation = await env.service.recommendDelegation(env.workspace, created.planId);
    assert.equal(recommendation.recommendedAgentCount, 3);
    const taskIds = recommendation.packages.flatMap((item) => item.taskIds);
    assert.ok(!(taskIds.includes("task-1") && taskIds.includes("task-2")));
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("artifact audit accepts an in-workspace file and rejects traversal", async () => {
  const env = await environment();
  try {
    await writeFile(join(env.workspace, "evidence.txt"), "assert public output equals expected\n", "utf8");
    await writeFile(join(env.root, "outside.txt"), "outside\n", "utf8");
    const candidate = definition(env.service, env.workspace, "Create the evidence.", "direct");
    const created = await env.service.createPlan(candidate);
    await env.service.startTask(env.workspace, created.planId, "task-1");
    const outsideEvidence = { ...strongEvidence("task-1-criterion"), artifact: { path: "../outside.txt", kind: "other" as const } };
    const rejected = await env.service.auditCompletion(env.workspace, created.planId, "task-1", "outside", [outsideEvidence], []);
    assert.equal(rejected.approved, false);
    assert.ok(rejected.issues.some((issue) => issue.includes("escapes the workspace")));

    const accepted = await env.service.auditCompletion(env.workspace, created.planId, "task-1", "inside", [{
      ...strongEvidence("task-1-criterion"), artifact: { path: "evidence.txt", kind: "test_source" as const },
    }], []);
    assert.equal(accepted.approved, true);
    assert.match(accepted.artifactHashes["evidence.txt"]!, /^[a-f0-9]{64}$/);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("a test-source artifact without an assertion is rejected even when its reported result passes", async () => {
  const env = await environment();
  try {
    await writeFile(join(env.workspace, "weak-test.ts"), "console.log('looks good');\n", "utf8");
    const candidate = definition(env.service, env.workspace, "Create the verified result.", "direct");
    const created = await env.service.createPlan(candidate);
    await env.service.startTask(env.workspace, created.planId, "task-1");
    const result = await env.service.auditCompletion(env.workspace, created.planId, "task-1", "reported pass", [{
      ...strongEvidence("task-1-criterion"), artifact: { path: "weak-test.ts", kind: "test_source" as const },
    }], []);
    assert.equal(result.approved, false);
    assert.ok(result.issues.some((issue) => issue.includes("no recognizable assertion")));
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("revision invalidates completion when acceptance contract changes", async () => {
  const env = await environment();
  try {
    const candidate = definition(env.service, env.workspace, "Create one thing.", "direct");
    const created = await env.service.createPlan(candidate);
    await env.service.startTask(env.workspace, created.planId, "task-1");
    await env.service.auditCompletion(env.workspace, created.planId, "task-1", "verified", [strongEvidence("task-1-criterion")], []);
    candidate.tasks[0]!.acceptanceCriteria[0]!.text = "Changed behavior is verified";
    const { workspaceRoot: _workspaceRoot, ...revision } = candidate;
    const revised = await env.service.revisePlan(env.workspace, created.planId, "Acceptance behavior changed", revision);
    assert.equal(revised.accepted, true);
    const plan = await env.service.getPlan(env.workspace, created.planId);
    assert.equal(plan.tasks[0]!.status, "pending");
    assert.equal(plan.tasks[0]!.verificationAttempts.length, 0);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("concurrent updates never corrupt or silently overwrite plan state", async () => {
  const env = await environment();
  try {
    const candidate = definition(env.service, env.workspace, "One. Two. Three. Four.");
    const created = await env.service.createPlan(candidate);
    const results = await Promise.allSettled([
      env.service.startTask(env.workspace, created.planId, "task-1", "agent-a"),
      env.service.startTask(env.workspace, created.planId, "task-2", "agent-b"),
    ]);
    assert.ok(results.some((result) => result.status === "fulfilled"));
    for (const rejected of results.filter((result) => result.status === "rejected")) {
      assert.match(String(rejected.reason), /concurrently/);
    }
    const plan = await env.service.getPlan(env.workspace, created.planId);
    const started = plan.tasks.filter((item) => item.status === "in_progress");
    assert.equal(started.length, results.filter((result) => result.status === "fulfilled").length);
    assert.ok(plan.stateVersion >= 2);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("a lock left by a crashed process is recovered without losing plan state", async () => {
  const env = await environment();
  try {
    const candidate = definition(env.service, env.workspace, "Create one result.", "direct");
    const created = await env.service.createPlan(candidate);
    const workspaceDirectories = await readdir(join(env.data, "workspaces"));
    assert.equal(workspaceDirectories.length, 1);
    const lockPath = join(env.data, "workspaces", workspaceDirectories[0]!, "plans", `${created.planId}.json.lock`);
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, createdAt: new Date(0).toISOString() }), "utf8");

    await env.service.startTask(env.workspace, created.planId, "task-1");
    const plan = await env.service.getPlan(env.workspace, created.planId);
    assert.equal(plan.tasks[0]!.status, "in_progress");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("a twenty-part request retains twenty atomic tasks without an arbitrary cap", async () => {
  const env = await environment();
  try {
    const request = Array.from({ length: 20 }, (_, index) => `Action ${index + 1}.`).join("\n");
    const candidate = definition(env.service, env.workspace, request);
    assert.equal(candidate.tasks.length, 20);
    const created = await env.service.createPlan(candidate);
    assert.equal(created.accepted, true);
    const plan = await env.service.getPlan(env.workspace, created.planId);
    assert.equal(plan.tasks.length, 20);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});
