import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const text = Type.String({ minLength: 1 });
const strings = Type.Array(text);
const object = <T extends Record<string, TSchema>>(fields: T) =>
  Type.Object(fields, { additionalProperties: false });
export const ActionSchema = object({
  text: Type.String(),
  toolCalls: Type.Array(
    object({ id: text, name: text, arguments: Type.Record(Type.String(), Type.Unknown()) }),
  ),
});
export type Action = Static<typeof ActionSchema>;
export const PROGRAM_ID = "pi-dspy-gepa.next-action.v1";
export const STAGES = ["plan", "implement", "review", "fix"] as const;
export type Stage = (typeof STAGES)[number];
export const ReviewSchema = object({
  schema: Type.Literal("pi-dspy-gepa.review.v1"),
  completeness: Type.Boolean(),
  correctness: Type.Boolean(),
  maintainability: Type.Boolean(),
  findings: text,
});
export type Review = Static<typeof ReviewSchema>;
const DecisionInputSchema = object({
  inheritedInstructions: Type.String(),
  brief: Type.String(),
  context: Type.String(),
  tools: Type.String(),
});
const ActionPolicySchema = object({
  instructions: text,
  demonstrations: Type.Array(object({ input: DecisionInputSchema, action: ActionSchema })),
});
export const StagesSchema = object({
  plan: ActionPolicySchema,
  implement: ActionPolicySchema,
  review: object({
    instructions: text,
    demonstrations: Type.Array(object({ input: DecisionInputSchema, review: ReviewSchema })),
  }),
  fix: ActionPolicySchema,
});
export const CandidateSchema = object({
  schema: Type.Literal("pi-dspy-gepa.candidate.v1"),
  programId: Type.Literal(PROGRAM_ID),
  repository: Type.Union([Type.Null(), text]),
  stages: StagesSchema,
  provenance: object({
    dspy: Type.Literal("3.3.1"),
    gepa: Type.Literal("0.1.4"),
    pi: Type.Literal("0.84.4"),
    programDigest: text,
  }),
});
export type Candidate = Static<typeof CandidateSchema>;
export const AuthoritySchema = object({
  edit: Type.Boolean(),
  test: Type.Boolean(),
  commit: Type.Boolean(),
  push: Type.Boolean(),
  pullRequest: Type.Boolean(),
  merge: Type.Boolean(),
  release: Type.Boolean(),
  deploy: Type.Boolean(),
});
export type Authority = Static<typeof AuthoritySchema>;
export const LOCAL_AUTHORITY: Authority = {
  edit: true,
  test: true,
  commit: false,
  push: false,
  pullRequest: false,
  merge: false,
  release: false,
  deploy: false,
};
export const AcceptanceSchema = object({
  criteria: Type.Array(text, { minItems: 1 }),
  commands: Type.Array(text, { minItems: 1 }),
});
export type Acceptance = Static<typeof AcceptanceSchema>;
export const AllowanceSchema = object({
  maxTrials: Type.Integer({ minimum: 1 }),
  trialDeadlineMs: Type.Integer({ minimum: 1 }),
  concurrency: Type.Integer({ minimum: 1 }),
  maxModelCalls: Type.Integer({ minimum: 1 }),
});
export type Allowance = Static<typeof AllowanceSchema>;
export const CaseSchema = object({
  schema: Type.Literal("pi-dspy-gepa.evaluation-case.v1"),
  id: text,
  role: Type.Union([Type.Literal("training"), Type.Literal("validation"), Type.Literal("heldOut")]),
  repository: text,
  startingCommit: text,
  task: text,
  setup: strings,
  acceptance: AcceptanceSchema,
  rubric: text,
});
export type EvaluationCase = Static<typeof CaseSchema>;
export type Status = "active" | "paused" | "blocked" | "cancelled" | "failed" | "completed";
export type CheckResult = { command: string; exitCode: number | null; outputPath: string };
export type Evidence = {
  schema: "pi-dspy-gepa.evidence.v1";
  fingerprint: string;
  checks: CheckResult[];
  workflowReview: Review | null;
  review: Review | null;
  error: string | null;
  passed: boolean;
  artifactPath: string;
};
export type Campaign = {
  schema: "pi-dspy-gepa.campaign.v1";
  id: string;
  repository: string;
  baseCommit: string;
  baseRef: string;
  worktree: string;
  sessionPath: string | null;
  goal: string;
  constraints: string[];
  authority: Authority;
  candidateId: string;
  status: Status;
  stage: Stage;
  plan: string | null;
  notes: string[];
  acceptance: Acceptance | null;
  evidence: Evidence | null;
  result: string | null;
  createdAt: string;
};
export type Trial = {
  schema: "pi-dspy-gepa.trial.v1";
  id: string;
  experimentId: string;
  candidateId: string;
  caseId: string;
  status: "completed" | "error" | "cancelled";
  score: number | null;
  evidence: Evidence | null;
  tracePath: string;
  tokens: number;
  cost: number | null;
  durationMs: number;
  error: string | null;
};
export function validate<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value))
    throw new Error(
      `Invalid structured value: ${JSON.stringify([...Value.Errors(schema, value)])}`,
    );
  return structuredClone(value) as Static<T>;
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)!).digest("hex");
}
export function candidateId(candidate: Candidate): string {
  return digest(validate(CandidateSchema, candidate));
}
