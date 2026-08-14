import type { EvidenceInput, PlanDefinitionInput, TaskInput } from "./schemas.js";

export type SourceUnitKind = "action" | "constraint" | "success_criterion" | "context";

export interface SourceUnit {
  id: string;
  text: string;
  kind: SourceUnitKind;
  signals: string[];
  ordinal: number;
}

export interface RequestAnalysis {
  requestHash: string;
  sourceUnits: SourceUnit[];
  recommendedMode: "direct" | "plan";
  reasons: string[];
}

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface StoredTask extends TaskInput {
  status: TaskStatus;
  owner?: string;
  startedAt?: string;
  completedAt?: string;
  verificationAttempts: VerificationAttempt[];
}

export interface VerificationAttempt {
  attemptedAt: string;
  approved: boolean;
  summary: string;
  evidence: EvidenceInput[];
  issues: string[];
  artifactHashes: Record<string, string>;
}

export interface StoredAdvice {
  appliedAt: string;
  recommendedNow: string[];
  deferUntilReset: string[];
  executionOrder: string[];
  checkpoint?: string;
  source: string;
}

export interface StoredPlan extends Omit<PlanDefinitionInput, "tasks"> {
  schemaVersion: 1;
  stateVersion: number;
  planId: string;
  requestHash: string;
  status: "draft" | "active" | "closed";
  accepted: boolean;
  validationIssues: string[];
  tasks: StoredTask[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  revision: number;
  revisionHistory: Array<{ at: string; reason: string }>;
  advice?: StoredAdvice;
}

export interface PlanValidation {
  accepted: boolean;
  issues: string[];
  coverage: {
    activeSourceUnits: number;
    coveredSourceUnits: number;
    activeRequirements: number;
    coveredRequirements: number;
  };
}
