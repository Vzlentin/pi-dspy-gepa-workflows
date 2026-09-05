import { readFile, writeFile } from "node:fs/promises";
import {
  AcceptanceSchema,
  PlanSchema,
  ReportSchema,
  ReviewSchema,
  validate,
  type Campaign,
  type Evidence,
  type Plan,
  type Report,
  type Review,
  type Stage,
  type Status,
} from "../state/contracts.js";
import type { Store } from "../state/store.js";
import { verify, type Reviewer } from "./verification.js";
import { treeSnapshot } from "./workspace.js";

export type StageState = { status: Status; stage: Stage };
export type StageInputs = StageState & { evidence: string | null };
/** The fixed stage order: plan -> implement -> review -> (fix -> review)* until the host accepts. */
const NEXT: Record<Stage, Stage> = {
  plan: "implement",
  implement: "review",
  review: "fix",
  fix: "review",
};

function passes(review: Review | null): boolean {
  return !!review && review.completeness && review.correctness && review.maintainability;
}

/** Host-owned campaign state and stage order. The DSPy program asks; this verifies, records, and advances. */
export class CampaignControl {
  private listeners = new Set<() => void>();
  constructor(
    readonly store: Store,
    readonly campaign: Campaign,
    readonly evaluator: Reviewer,
    readonly artifacts: string,
  ) {}
  changed(): void {
    this.store.saveCampaign(this.campaign);
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  status(): StageState {
    return { status: this.campaign.status, stage: this.campaign.stage };
  }
  pause(): void {
    if (this.campaign.status === "active") {
      this.campaign.status = "paused";
      this.changed();
    }
  }
  continue(): void {
    if (this.campaign.status === "completed" || this.campaign.status === "cancelled")
      throw new Error("Completed or cancelled campaigns cannot continue");
    this.campaign.status = "active";
    this.campaign.result = null;
    this.changed();
  }
  stop(status: "cancelled" | "failed", reason: string): void {
    this.campaign.status = status;
    this.campaign.result = reason;
    this.changed();
  }
  /** Enter the recorded stage. Review first runs the recorded checks and the fixed evaluator. */
  async begin(signal: AbortSignal): Promise<StageInputs> {
    signal.throwIfAborted();
    if (this.campaign.status !== "active") return { ...this.status(), evidence: null };
    const { stage } = this.campaign;
    if (stage !== "plan" && !this.campaign.plan) throw new Error(`Record the plan before ${stage}`);
    let evidence: string | null = null;
    if (stage === "review") {
      this.campaign.evidence = null;
      this.changed();
      this.campaign.evidence = await verify(this.campaign, this.artifacts, this.evaluator, signal);
      evidence = await this.reviewEvidence(this.campaign.evidence);
    }
    this.changed();
    return { ...this.status(), evidence };
  }
  private async reviewEvidence(evidence: Evidence): Promise<string> {
    const { diff } = await treeSnapshot(this.campaign.worktree, this.campaign.baseCommit);
    const checks = await Promise.all(
      evidence.checks.map(
        async (check) =>
          `## Check: ${check.command}\nExit code: ${check.exitCode ?? "Unavailable"}\nFull output: ${check.outputPath}\n\n${await readFile(check.outputPath, "utf8")}`,
      ),
    );
    return [
      `## Verification error\n${evidence.error ?? "None."}`,
      ...checks,
      `## Complete diff against ${this.campaign.baseCommit}, including untracked files\n${diff}`,
    ].join("\n\n");
  }
  /**
   * Persist the recorded stage's typed output and advance; only a passing review completes the
   * campaign. A pause still records finished work: the next `begin` is what stops the workflow.
   */
  async record(output: unknown): Promise<StageState> {
    if (!["active", "paused"].includes(this.campaign.status))
      throw new Error(`Campaign is ${this.campaign.status}`);
    const { stage } = this.campaign;
    if (stage === "plan") this.recordPlan(validate(PlanSchema, output));
    else if (stage === "review") await this.recordReview(validate(ReviewSchema, output));
    else this.recordReport(stage, validate(ReportSchema, output));
    if (["active", "paused"].includes(this.campaign.status)) this.campaign.stage = NEXT[stage];
    this.changed();
    return this.status();
  }
  private block(reason: string): void {
    this.campaign.status = "blocked";
    this.campaign.result = reason;
  }
  private recordPlan(plan: Plan) {
    if (plan.blocker) return this.block(plan.blocker);
    if (this.campaign.plan) throw new Error("Plan is already recorded");
    if (!plan.plan.trim()) throw new Error("A complete plan is required");
    // Acceptance supplied at launch is immutable; a plan cannot replace or weaken it.
    this.campaign.acceptance ??= validate(AcceptanceSchema, {
      criteria: plan.criteria,
      commands: plan.commands,
    });
    this.campaign.plan = plan.plan;
  }
  private recordReport(stage: Stage, report: Report) {
    this.campaign.notes.push(`${stage}: ${report.summary || "No summary."}`, ...report.notes);
    if (report.blocker) this.block(report.blocker);
  }
  private async recordReview(review: Review): Promise<void> {
    const evidence = this.campaign.evidence;
    if (!evidence) throw new Error("Review requires verification evidence");
    evidence.workflowReview = review;
    const { fingerprint } = await treeSnapshot(this.campaign.worktree);
    if (!evidence.error && fingerprint !== evidence.fingerprint)
      evidence.error = "Working tree changed during review";
    evidence.passed = !evidence.error && passes(evidence.review) && passes(review);
    await writeFile(evidence.artifactPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    if (evidence.passed) {
      this.campaign.status = "completed";
      this.campaign.result = review.findings;
    }
  }
  brief(): string {
    const c = this.campaign;
    return [
      `# Campaign ${c.id}`,
      `Status: ${c.status}\nStage: ${c.stage}\nCandidate: ${c.candidateId}`,
      `## Goal\n${c.goal}`,
      `## Workspace\nRepository: ${c.repository}\nWorktree: ${c.worktree}\nBase ref: ${c.baseRef}\nBase commit: ${c.baseCommit}\nStage transcripts: ${this.artifacts}/sessions`,
      "## Authority\n" +
        Object.entries(c.authority)
          .map(([action, allowed]) => `- ${action}: ${allowed ? "allowed" : "forbidden"}`)
          .join("\n"),
      `## Constraints and inherited instructions\n${c.constraints.join("\n\n") || "None recorded."}`,
      `## Plan\n${c.plan ?? "Not recorded yet."}`,
      `## Acceptance criteria\n${c.acceptance?.criteria.join("\n\n") ?? "Not recorded yet."}`,
      `## Verification commands\n${c.acceptance?.commands.join("\n\n") ?? "Not recorded yet."}`,
      ...(c.evidence ? evidenceBrief(c.evidence) : ["## Latest verification\nNot run yet."]),
      `## Saved notes\n${c.notes.join("\n\n") || "None."}`,
      `## Result or blocker\n${c.result ?? "None."}`,
    ].join("\n\n");
  }
}
function evidenceBrief(evidence: Evidence): string[] {
  return [
    `## Latest verification\nPassed: ${evidence.passed}\nFingerprint: ${evidence.fingerprint}\nEvidence: ${evidence.artifactPath}\nError: ${evidence.error ?? "None."}`,
    ...evidence.checks.map(
      (check) =>
        `Command: ${check.command}\nExit code: ${check.exitCode ?? "Unavailable"}\nFull output: ${check.outputPath}`,
    ),
    ...(
      [
        ["Workflow review", evidence.workflowReview],
        ["Independent acceptance", evidence.review],
      ] as const
    ).map(([title, review]) =>
      review
        ? `### ${title}\nCompleteness: ${review.completeness}\nCorrectness: ${review.correctness}\nMaintainability: ${review.maintainability}\n\n${review.findings}`
        : `### ${title}\nNot available.`,
    ),
  ];
}
