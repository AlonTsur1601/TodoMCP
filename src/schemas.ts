import { z } from "zod";

export const EvidenceLevelSchema = z.enum([
  "static",
  "build",
  "unit",
  "integration",
  "runtime",
  "manual",
]);

export const RequestAnalysisInputSchema = z.object({
  request: z.string().min(1).max(100_000),
}).strict();

export const RequirementSchema = z.object({
  id: z.string().min(1).max(100),
  text: z.string().min(1).max(10_000),
  sourceUnitIds: z.array(z.string().min(1)).min(1).max(5_000),
  disposition: z.enum(["active", "context_only", "duplicate", "out_of_scope"]),
  reason: z.string().min(1).max(2_000).optional(),
}).strict();

export const CriterionSchema = z.object({
  id: z.string().min(1).max(100),
  text: z.string().min(1).max(5_000),
  requiredEvidence: EvidenceLevelSchema,
  observableInterface: z.boolean().default(false),
  requiresBoundaryCases: z.boolean().default(false),
}).strict();

export const TaskSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  objective: z.string().min(1).max(5_000),
  deliverables: z.array(z.string().min(1).max(2_000)).min(1).max(100),
  requirementIds: z.array(z.string().min(1)).min(1).max(5_000),
  dependencies: z.array(z.string().min(1)).max(5_000).default([]),
  expectedFiles: z.array(z.string().min(1)).max(1_000).default([]),
  acceptanceCriteria: z.array(CriterionSchema).min(1).max(500),
  priority: z.number().int().min(1).max(5).default(3),
  estimatedMinutes: z.number().int().positive().max(100_000),
  risk: z.enum(["low", "medium", "high"]).default("low"),
  parallelizable: z.boolean().default(false),
  needsUserInput: z.boolean().default(false),
  canContinueWithoutNewMessage: z.boolean().default(true),
  checkpointable: z.boolean().default(true),
}).strict();

export const PlanDefinitionSchema = z.object({
  workspaceRoot: z.string().min(1),
  originalRequest: z.string().min(1).max(100_000),
  mode: z.enum(["direct", "plan"]),
  requirements: z.array(RequirementSchema).min(1).max(5_000),
  tasks: z.array(TaskSchema).min(1).max(5_000),
  externalContext: z.record(z.string(), z.unknown()).optional(),
  correlationId: z.string().max(500).optional(),
}).strict();

export const CreatePlanInputSchema = PlanDefinitionSchema;

export const RevisePlanInputSchema = PlanDefinitionSchema.extend({
  planId: z.string().uuid(),
  revisionReason: z.string().min(1).max(5_000),
}).strict();

export const PlanReferenceSchema = z.object({
  workspaceRoot: z.string().min(1),
  planId: z.string().uuid(),
}).strict();

export const StartTaskInputSchema = PlanReferenceSchema.extend({
  taskId: z.string().min(1),
  owner: z.string().max(500).optional(),
}).strict();

export const AdviceSchema = z.object({
  recommendedNow: z.array(z.string().min(1)).max(5_000),
  deferUntilReset: z.array(z.string().min(1)).max(5_000).default([]),
  executionOrder: z.array(z.string().min(1)).max(5_000).default([]),
  checkpoint: z.string().max(5_000).optional(),
  source: z.string().max(500).default("external-advisor"),
}).passthrough();

export const ApplyAdviceInputSchema = PlanReferenceSchema.extend({
  advice: AdviceSchema,
}).strict();

export const ArtifactSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  kind: z.enum(["test_source", "output", "other"]).default("other"),
}).strict();

export const EvidenceSchema = z.object({
  criterionId: z.string().min(1),
  method: EvidenceLevelSchema,
  target: z.string().min(1).max(5_000),
  input: z.string().min(1).max(20_000),
  expected: z.string().min(1).max(20_000),
  observed: z.string().min(1).max(20_000),
  rawOutput: z.string().min(1).max(100_000),
  failureSensitivity: z.string().min(1).max(20_000),
  limitations: z.string().max(20_000).optional(),
  observesPublicInterface: z.boolean().default(false),
  boundaryCases: z.array(z.string().min(1)).max(500).default([]),
  artifact: ArtifactSchema.optional(),
}).strict();

export const AuditCompletionInputSchema = PlanReferenceSchema.extend({
  taskId: z.string().min(1),
  summary: z.string().min(1).max(20_000),
  evidence: z.array(EvidenceSchema).min(1).max(5_000),
  unresolvedIssues: z.array(z.string().min(1)).max(5_000).default([]),
}).strict();

export type EvidenceLevel = z.infer<typeof EvidenceLevelSchema>;
export type RequirementInput = z.infer<typeof RequirementSchema>;
export type CriterionInput = z.infer<typeof CriterionSchema>;
export type TaskInput = z.infer<typeof TaskSchema>;
export type PlanDefinitionInput = z.infer<typeof PlanDefinitionSchema>;
export type EvidenceInput = z.infer<typeof EvidenceSchema>;
