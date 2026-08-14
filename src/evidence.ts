import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { EvidenceInput, EvidenceLevel } from "./schemas.js";
import type { StoredTask } from "./types.js";

const LEVEL: Record<EvidenceLevel, number> = {
  static: 0,
  build: 1,
  unit: 2,
  integration: 3,
  runtime: 4,
  manual: 4,
};

function weakText(value: string): boolean {
  return /^(?:pass(?:ed)?|ok|success|works?|done|none|n\/a|כן|עבר|עובד|בוצע)[.!]?$/iu.test(value.trim());
}

const FAILURE_SENSITIVITY_RE = /(?:fail|failure|changing|change|mutation|negative|pre[- ]?fix|reject|wrong|break|נכשל|כשל|שינוי|מוטציה|שלילי|דחייה|שגוי)/iu;
const ASSERTION_RE = /(?:\bassert(?:\.|\s|\()|\bexpect\s*\(|\bshould\b|\bthrows?\b|\brejects?\b|\[Fact\]|\[Test\]|@Test\b|pytest\.|unittest\.|if\s*\([^)]*\)\s*throw)/iu;

async function verifyArtifact(workspaceRoot: string, evidence: EvidenceInput): Promise<{ hash?: string; issue?: string }> {
  if (!evidence.artifact) return {};
  try {
    const root = await realpath(resolve(workspaceRoot));
    const candidate = isAbsolute(evidence.artifact.path)
      ? resolve(evidence.artifact.path)
      : resolve(root, evidence.artifact.path);
    const resolved = await realpath(candidate);
    const pathRelative = relative(root, resolved);
    if (pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) {
      return { issue: `Artifact escapes the workspace: ${evidence.artifact.path}.` };
    }
    const stats = await lstat(resolved);
    if (!stats.isFile()) return { issue: `Artifact is not a regular file: ${evidence.artifact.path}.` };
    if (stats.size > 1_048_576) return { issue: `Artifact exceeds the 1 MiB audit limit: ${evidence.artifact.path}.` };
    const bytes = await readFile(resolved);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (evidence.artifact.sha256 && evidence.artifact.sha256.toLowerCase() !== hash) {
      return { issue: `Artifact hash does not match current file: ${evidence.artifact.path}.` };
    }
    if (evidence.artifact.kind === "test_source" && !ASSERTION_RE.test(bytes.toString("utf8"))) {
      return { hash, issue: `Test source artifact has no recognizable assertion or failure check: ${evidence.artifact.path}.` };
    }
    return { hash };
  } catch (error) {
    return { issue: `Artifact cannot be verified (${evidence.artifact.path}): ${(error as Error).message}` };
  }
}

export async function auditTaskEvidence(
  workspaceRoot: string,
  task: Pick<StoredTask, "acceptanceCriteria">,
  evidenceItems: EvidenceInput[],
  unresolvedIssues: string[],
): Promise<{ approved: boolean; issues: string[]; artifactHashes: Record<string, string> }> {
  const issues: string[] = [];
  const artifactHashes: Record<string, string> = {};
  if (unresolvedIssues.length > 0) issues.push(`Unresolved issues remain: ${unresolvedIssues.join("; ")}.`);
  const criteria = new Map(task.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
  const evidenceByCriterion = new Map<string, EvidenceInput[]>();

  for (const evidence of evidenceItems) {
    if (!criteria.has(evidence.criterionId)) {
      issues.push(`Evidence references unknown criterion ${evidence.criterionId}.`);
      continue;
    }
    const list = evidenceByCriterion.get(evidence.criterionId) ?? [];
    list.push(evidence);
    evidenceByCriterion.set(evidence.criterionId, list);
  }

  for (const criterion of task.acceptanceCriteria) {
    const items = evidenceByCriterion.get(criterion.id) ?? [];
    if (items.length === 0) {
      issues.push(`Criterion ${criterion.id} has no evidence.`);
      continue;
    }
    for (const evidence of items) {
      if (LEVEL[evidence.method] < LEVEL[criterion.requiredEvidence]) {
        issues.push(`Criterion ${criterion.id} requires ${criterion.requiredEvidence} evidence; ${evidence.method} is insufficient.`);
      }
      if (criterion.requiredEvidence !== "static" && criterion.requiredEvidence !== "build" && evidence.method === "build") {
        issues.push(`Build-only evidence cannot prove behavioral criterion ${criterion.id}.`);
      }
      if (weakText(evidence.rawOutput) || evidence.rawOutput.trim().length < 12) {
        issues.push(`Criterion ${criterion.id} needs substantive raw output, not a summary-only result.`);
      }
      if (weakText(evidence.failureSensitivity) || evidence.failureSensitivity.trim().length < 20 || !FAILURE_SENSITIVITY_RE.test(evidence.failureSensitivity)) {
        issues.push(`Criterion ${criterion.id} does not explain how the check can detect failure.`);
      }
      if (weakText(evidence.expected) || weakText(evidence.observed)) {
        issues.push(`Criterion ${criterion.id} needs explicit expected and observed signals.`);
      }
      if (criterion.observableInterface && !evidence.observesPublicInterface) {
        issues.push(`Criterion ${criterion.id} must be verified through the observable interface.`);
      }
      if (criterion.requiresBoundaryCases && evidence.boundaryCases.length === 0) {
        issues.push(`Criterion ${criterion.id} requires boundary or negative-case evidence.`);
      }
      const artifact = await verifyArtifact(workspaceRoot, evidence);
      if (artifact.issue) issues.push(artifact.issue);
      if (artifact.hash && evidence.artifact) artifactHashes[evidence.artifact.path] = artifact.hash;
    }
  }
  return { approved: issues.length === 0, issues, artifactHashes };
}
