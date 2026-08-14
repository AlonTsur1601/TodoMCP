import { createHash, randomUUID } from "node:crypto";
import { analyzeRequest } from "./analyzer.js";
import { auditTaskEvidence } from "./evidence.js";
import type {
  EvidenceInput,
  PlanDefinitionInput,
  RequirementInput,
  TaskInput,
} from "./schemas.js";
import { PlanStore } from "./store.js";
import type { StoredAdvice, StoredPlan, StoredTask } from "./types.js";
import { validatePlan } from "./validator.js";

function now(): string {
  return new Date().toISOString();
}

function requestHash(request: string): string {
  return createHash("sha256").update(request).digest("hex");
}

function freshTask(task: TaskInput): StoredTask {
  return { ...task, status: "pending", verificationAttempts: [] };
}

function verificationSignature(task: Pick<StoredTask, "deliverables" | "acceptanceCriteria" | "requirementIds">): string {
  return JSON.stringify({
    deliverables: task.deliverables,
    acceptanceCriteria: task.acceptanceCriteria,
    requirementIds: task.requirementIds,
  });
}

function readyTasks(plan: StoredPlan): StoredTask[] {
  const completed = new Set(plan.tasks.filter((task) => task.status === "completed").map((task) => task.id));
  const ready = plan.tasks.filter(
    (task) => task.status !== "completed" && task.dependencies.every((dependency) => completed.has(dependency)),
  );
  const adviceOrder = plan.advice?.executionOrder ?? plan.advice?.recommendedNow ?? [];
  const order = new Map(adviceOrder.map((id, index) => [id, index]));
  return ready.sort((left, right) => {
    const leftOrder = order.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || right.priority - left.priority || left.estimatedMinutes - right.estimatedMinutes;
  });
}

function planView(plan: StoredPlan) {
  const ready = readyTasks(plan).map((task) => task.id);
  return {
    ...plan,
    readyTaskIds: ready,
    blockedTaskIds: plan.tasks
      .filter((task) => task.status === "pending" && !ready.includes(task.id))
      .map((task) => task.id),
    nextTaskId: nextRecommendedTaskId(plan),
  };
}

function nextRecommendedTaskId(plan: StoredPlan): string | null {
  const ready = readyTasks(plan).map((task) => task.id);
  if (!plan.advice) return ready[0] ?? null;
  const deferred = new Set(plan.advice.deferUntilReset);
  const preferred = [...plan.advice.executionOrder, ...plan.advice.recommendedNow];
  return preferred.find((id) => ready.includes(id) && !deferred.has(id))
    ?? ready.find((id) => !deferred.has(id))
    ?? null;
}

export class TodoService {
  constructor(private readonly store = new PlanStore()) {}

  analyze(request: string) {
    return analyzeRequest(request);
  }

  async createPlan(definition: PlanDefinitionInput) {
    const analysis = analyzeRequest(definition.originalRequest);
    const validation = validatePlan(definition, analysis);
    const timestamp = now();
    const plan: StoredPlan = {
      ...definition,
      schemaVersion: 1,
      stateVersion: 1,
      planId: randomUUID(),
      requestHash: analysis.requestHash,
      status: validation.accepted ? "active" : "draft",
      accepted: validation.accepted,
      validationIssues: validation.issues,
      tasks: definition.tasks.map(freshTask),
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
      revisionHistory: [],
    };
    await this.store.write(plan, { type: "plan_created", accepted: validation.accepted, issues: validation.issues });
    return { planId: plan.planId, status: plan.status, ...validation, analysis };
  }

  async revisePlan(
    workspaceRoot: string,
    planId: string,
    revisionReason: string,
    definition: Omit<PlanDefinitionInput, "workspaceRoot">,
  ) {
    const existing = await this.store.read(workspaceRoot, planId);
    const expectedStateVersion = existing.stateVersion;
    if (existing.status === "closed") throw new Error("Closed plans cannot be revised.");
    const fullDefinition: PlanDefinitionInput = { workspaceRoot, ...definition };
    const analysis = analyzeRequest(fullDefinition.originalRequest);
    const validation = validatePlan(fullDefinition, analysis);
    const existingById = new Map(existing.tasks.map((task) => [task.id, task]));
    const tasks = fullDefinition.tasks.map((task): StoredTask => {
      const prior = existingById.get(task.id);
      if (!prior || verificationSignature(prior) !== verificationSignature(task)) {
        return freshTask(task);
      }
      return { ...task, status: prior.status, verificationAttempts: prior.verificationAttempts,
        ...(prior.owner ? { owner: prior.owner } : {}),
        ...(prior.startedAt ? { startedAt: prior.startedAt } : {}),
        ...(prior.completedAt ? { completedAt: prior.completedAt } : {}) };
    });
    const updated: StoredPlan = {
      ...existing,
      ...fullDefinition,
      requestHash: requestHash(fullDefinition.originalRequest),
      accepted: validation.accepted,
      status: validation.accepted ? "active" : "draft",
      validationIssues: validation.issues,
      tasks,
      updatedAt: now(),
      stateVersion: existing.stateVersion + 1,
      revision: existing.revision + 1,
      revisionHistory: [...existing.revisionHistory, { at: now(), reason: revisionReason }],
    };
    delete updated.advice;
    await this.store.write(updated, { type: "plan_revised", accepted: validation.accepted, reason: revisionReason }, expectedStateVersion);
    return { planId, status: updated.status, ...validation, analysis };
  }

  async getPlan(workspaceRoot: string, planId: string) {
    return planView(await this.store.read(workspaceRoot, planId));
  }

  async startTask(workspaceRoot: string, planId: string, taskId: string, owner?: string) {
    const plan = await this.store.read(workspaceRoot, planId);
    const expectedStateVersion = plan.stateVersion;
    if (!plan.accepted || plan.status !== "active") throw new Error("Only accepted active plans can start tasks.");
    const task = plan.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Unknown task ${taskId}.`);
    if (task.status === "completed") throw new Error(`Task ${taskId} is already completed.`);
    const ready = new Set(readyTasks(plan).map((candidate) => candidate.id));
    if (!ready.has(taskId)) throw new Error(`Task ${taskId} is blocked by incomplete dependencies.`);
    task.status = "in_progress";
    task.startedAt ??= now();
    if (owner) task.owner = owner;
    plan.updatedAt = now();
    plan.stateVersion += 1;
    await this.store.write(plan, { type: "task_started", taskId, owner: owner ?? null }, expectedStateVersion);
    return { planId, taskId, status: task.status, startedAt: task.startedAt };
  }

  async recommendDelegation(workspaceRoot: string, planId: string) {
    const plan = await this.store.read(workspaceRoot, planId);
    const candidates = readyTasks(plan)
      .filter((task) => task.status === "pending" && task.parallelizable && task.risk !== "high" && task.estimatedMinutes >= 30)
      .sort((left, right) => right.priority - left.priority || right.estimatedMinutes - left.estimatedMinutes);
    const selected: StoredTask[] = [];
    const occupiedFiles = new Set<string>();
    for (const task of candidates) {
      const normalizedFiles = task.expectedFiles.map((file) => file.replaceAll("\\", "/").toLowerCase());
      if (normalizedFiles.some((file) => occupiedFiles.has(file))) continue;
      selected.push(task);
      normalizedFiles.forEach((file) => occupiedFiles.add(file));
      if (selected.length === 3) break;
    }
    return {
      recommendedAgentCount: selected.length,
      packages: selected.map((task) => ({
        taskIds: [task.id],
        title: task.title,
        rationale: "Independent ready work with bounded deliverables and no detected file overlap.",
        estimatedMinutes: task.estimatedMinutes,
        expectedFiles: task.expectedFiles,
      })),
      usageWarning: selected.length > 0 ? "Additional agents consume more usage; create only the recommended bounded packages." : null,
    };
  }

  async getExecutionCandidates(workspaceRoot: string, planId: string) {
    const plan = await this.store.read(workspaceRoot, planId);
    const currentTask = plan.tasks.find((task) => task.status === "in_progress");
    return {
      schemaVersion: "WorkCandidate.v1",
      ...(currentTask ? { currentTaskId: currentTask.id } : {}),
      tasks: readyTasks(plan).map((task) => ({
        id: task.id,
        title: task.title,
        priority: task.priority,
        estimatedMinutes: task.estimatedMinutes,
        dependenciesReady: true,
        needsUserInput: task.needsUserInput,
        canContinueWithoutNewMessage: task.canContinueWithoutNewMessage,
        checkpointable: task.checkpointable,
      })),
    };
  }

  async applyExecutionAdvice(workspaceRoot: string, planId: string, advice: Omit<StoredAdvice, "appliedAt">) {
    const plan = await this.store.read(workspaceRoot, planId);
    const expectedStateVersion = plan.stateVersion;
    const readyIds = new Set(readyTasks(plan).map((task) => task.id));
    const referenced = [...advice.recommendedNow, ...advice.deferUntilReset, ...advice.executionOrder];
    const invalid = [...new Set(referenced.filter((id) => !readyIds.has(id)))];
    if (invalid.length > 0) throw new Error(`Advice references tasks that are unknown or not ready: ${invalid.join(", ")}.`);
    const overlap = advice.recommendedNow.filter((id) => advice.deferUntilReset.includes(id));
    if (overlap.length > 0) throw new Error(`Advice cannot both recommend and defer the same task: ${[...new Set(overlap)].join(", ")}.`);
    for (const [name, taskIds] of Object.entries({
      recommendedNow: advice.recommendedNow,
      deferUntilReset: advice.deferUntilReset,
      executionOrder: advice.executionOrder,
    })) {
      if (new Set(taskIds).size !== taskIds.length) throw new Error(`Advice ${name} contains duplicate task ids.`);
    }
    plan.advice = { ...advice, appliedAt: now() };
    plan.updatedAt = now();
    plan.stateVersion += 1;
    await this.store.write(plan, { type: "execution_advice_applied", source: advice.source }, expectedStateVersion);
    return { applied: true, nextTaskId: nextRecommendedTaskId(plan), advice: plan.advice };
  }

  async auditCompletion(
    workspaceRoot: string,
    planId: string,
    taskId: string,
    summary: string,
    evidence: EvidenceInput[],
    unresolvedIssues: string[],
  ) {
    const plan = await this.store.read(workspaceRoot, planId);
    const expectedStateVersion = plan.stateVersion;
    if (!plan.accepted || plan.status !== "active") throw new Error("Only accepted active plans can complete tasks.");
    const task = plan.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Unknown task ${taskId}.`);
    if (task.status !== "in_progress") throw new Error(`Task ${taskId} must be started before completion audit.`);
    const audit = await auditTaskEvidence(workspaceRoot, task, evidence, unresolvedIssues);
    task.verificationAttempts.push({ attemptedAt: now(), approved: audit.approved, summary, evidence, issues: audit.issues, artifactHashes: audit.artifactHashes });
    if (audit.approved) {
      task.status = "completed";
      task.completedAt = now();
    }
    plan.updatedAt = now();
    plan.stateVersion += 1;
    await this.store.write(plan, { type: "completion_audited", taskId, approved: audit.approved, issues: audit.issues }, expectedStateVersion);
    return { taskId, approved: audit.approved, status: task.status, issues: audit.issues, artifactHashes: audit.artifactHashes };
  }

  async closePlan(workspaceRoot: string, planId: string) {
    const plan = await this.store.read(workspaceRoot, planId);
    const expectedStateVersion = plan.stateVersion;
    if (!plan.accepted) throw new Error("A rejected draft cannot be closed.");
    const incomplete = plan.tasks.filter((task) => task.status !== "completed").map((task) => task.id);
    if (incomplete.length > 0) throw new Error(`Plan cannot close; incomplete tasks: ${incomplete.join(", ")}.`);
    const activeRequirements = new Set(plan.requirements.filter((requirement) => requirement.disposition === "active").map((requirement) => requirement.id));
    const completedCoverage = new Set(plan.tasks.flatMap((task) => task.requirementIds));
    const uncovered = [...activeRequirements].filter((requirement) => !completedCoverage.has(requirement));
    if (uncovered.length > 0) throw new Error(`Plan cannot close; uncovered requirements: ${uncovered.join(", ")}.`);
    plan.status = "closed";
    plan.closedAt = now();
    plan.updatedAt = now();
    plan.stateVersion += 1;
    await this.store.write(plan, { type: "plan_closed" }, expectedStateVersion);
    return {
      planId,
      closed: true,
      closedAt: plan.closedAt,
      verificationSummary: plan.tasks.map((task) => ({ taskId: task.id, attempts: task.verificationAttempts.length, approvedAt: task.completedAt })),
    };
  }
}

export type { RequirementInput };
