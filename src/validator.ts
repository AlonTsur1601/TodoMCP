import type { PlanDefinitionInput, TaskInput } from "./schemas.js";
import type { PlanValidation, RequestAnalysis } from "./types.js";

const VAGUE_RE = /^(?:implement|finish|complete|handle|work on|test|fix|do|update|build|ליישם|לסיים|לטפל|לעבוד על|לבדוק|לתקן|לעדכן|לבנות)(?:\s+(?:it|this|everything|הכול|זה))?[.!]?$/iu;

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate];
}

function hasCycle(tasks: TaskInput[]): boolean {
  const taskIds = new Set(tasks.map((task) => task.id));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id) || !taskIds.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return tasks.some((task) => visit(task.id));
}

export function validatePlan(definition: PlanDefinitionInput, analysis: RequestAnalysis): PlanValidation {
  const issues: string[] = [];
  const sourceIds = new Set(analysis.sourceUnits.map((unit) => unit.id));
  const activeSourceIds = new Set(analysis.sourceUnits.filter((unit) => unit.kind !== "context").map((unit) => unit.id));
  const requirementIds = new Set(definition.requirements.map((requirement) => requirement.id));
  const activeRequirements = definition.requirements.filter((requirement) => requirement.disposition === "active");
  const activeRequirementIds = new Set(activeRequirements.map((requirement) => requirement.id));
  const taskIds = new Set(definition.tasks.map((task) => task.id));
  const sourceById = new Map(analysis.sourceUnits.map((unit) => [unit.id, unit]));
  const requirementById = new Map(definition.requirements.map((requirement) => [requirement.id, requirement]));

  if (definition.mode === "direct" && analysis.recommendedMode === "plan") {
    issues.push(`Direct mode is too small for this request: ${analysis.reasons.join(", ")}.`);
  }
  if (definition.mode === "direct" && definition.tasks.length > 3) issues.push("Direct mode permits at most three atomic tasks.");

  for (const duplicate of duplicates(definition.requirements.map((requirement) => requirement.id))) issues.push(`Duplicate requirement id: ${duplicate}.`);
  for (const duplicate of duplicates(definition.tasks.map((task) => task.id))) issues.push(`Duplicate task id: ${duplicate}.`);

  const coveredSources = new Set<string>();
  for (const requirement of definition.requirements) {
    if (requirement.disposition !== "active" && !requirement.reason?.trim()) {
      issues.push(`Requirement ${requirement.id} needs a reason for disposition ${requirement.disposition}.`);
    }
    for (const sourceId of requirement.sourceUnitIds) {
      if (!sourceIds.has(sourceId)) issues.push(`Requirement ${requirement.id} references unknown source unit ${sourceId}.`);
      else coveredSources.add(sourceId);
    }
    const actionSources = requirement.sourceUnitIds.filter((sourceId) => sourceById.get(sourceId)?.kind === "action");
    if (requirement.disposition === "active" && actionSources.length > 1) {
      issues.push(`Active requirement ${requirement.id} combines multiple actionable source units; split it into atomic requirements.`);
    }
  }
  for (const sourceId of sourceIds) {
    if (!coveredSources.has(sourceId)) issues.push(`Source unit ${sourceId} is not mapped to an explicit requirement disposition.`);
  }

  const coveredRequirements = new Set<string>();
  for (const task of definition.tasks) {
    if (task.deliverables.length !== 1) issues.push(`Task ${task.id} must have exactly one independently verifiable deliverable.`);
    if (VAGUE_RE.test(task.title.trim()) || VAGUE_RE.test(task.objective.trim())) issues.push(`Task ${task.id} is too vague.`);
    if (definition.mode === "direct" && task.dependencies.length > 0) issues.push(`Direct task ${task.id} cannot have dependencies.`);
    if (definition.mode === "direct" && task.risk === "high") issues.push(`High-risk task ${task.id} requires plan mode.`);
    for (const requirementId of task.requirementIds) {
      if (!requirementIds.has(requirementId)) issues.push(`Task ${task.id} references unknown requirement ${requirementId}.`);
      if (!activeRequirementIds.has(requirementId)) issues.push(`Task ${task.id} references inactive requirement ${requirementId}.`);
      coveredRequirements.add(requirementId);
    }
    const taskActionSources = new Set(task.requirementIds.flatMap((requirementId) =>
      requirementById.get(requirementId)?.sourceUnitIds.filter((sourceId) => sourceById.get(sourceId)?.kind === "action") ?? []
    ));
    if (taskActionSources.size > 1) {
      issues.push(`Task ${task.id} combines multiple actionable source units; create separate atomic tasks.`);
    }
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency)) issues.push(`Task ${task.id} depends on unknown task ${dependency}.`);
      if (dependency === task.id) issues.push(`Task ${task.id} depends on itself.`);
    }
    const criterionDuplicates = duplicates(task.acceptanceCriteria.map((criterion) => criterion.id));
    for (const duplicate of criterionDuplicates) issues.push(`Task ${task.id} has duplicate criterion id ${duplicate}.`);
  }
  if (hasCycle(definition.tasks)) issues.push("Task dependency graph contains a cycle.");
  for (const requirement of activeRequirements) {
    if (!coveredRequirements.has(requirement.id)) issues.push(`Active requirement ${requirement.id} is not covered by a task.`);
  }

  return {
    accepted: issues.length === 0,
    issues,
    coverage: {
      activeSourceUnits: activeSourceIds.size,
      coveredSourceUnits: [...activeSourceIds].filter((id) => coveredSources.has(id)).length,
      activeRequirements: activeRequirementIds.size,
      coveredRequirements: [...activeRequirementIds].filter((id) => coveredRequirements.has(id)).length,
    },
  };
}
