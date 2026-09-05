import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Campaign, type Evidence, ReviewSchema, validate } from "../state/contracts.js";
import { run } from "./process.js";
import { treeSnapshot } from "./workspace.js";

export type Reviewer = (
  input: {
    goal: string;
    plan: string | null;
    constraints: string[];
    criteria: string[];
    diff: string;
    checks: Evidence["checks"];
  },
  signal: AbortSignal,
) => Promise<unknown>;
export type Reviewers = { workflow: Reviewer; acceptance: Reviewer };
export async function verify(
  campaign: Campaign,
  artifacts: string,
  reviewers: Reviewers,
  signal: AbortSignal,
): Promise<Evidence> {
  const directory = join(artifacts, randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const before = await treeSnapshot(campaign.worktree, campaign.baseCommit);
  const evidence: Evidence = {
    schema: "pi-dspy-gepa.evidence.v1",
    fingerprint: before.fingerprint,
    checks: [],
    workflowReview: null,
    review: null,
    error: null,
    passed: false,
    artifactPath: join(directory, "evidence.json"),
  };
  try {
    if (!campaign.acceptance?.commands.length)
      throw new Error("Record acceptance criteria and verification commands before completion");
    if (!campaign.authority.test) throw new Error("Campaign has no test execution authority");
    for (const [index, command] of campaign.acceptance.commands.entries()) {
      signal.throwIfAborted();
      const outputPath = join(directory, `check-${index}.log`);
      const result = await run("/bin/sh", ["-c", command], campaign.worktree, {
        signal,
        outputPath,
      });
      evidence.checks.push({ command, exitCode: result.exitCode, outputPath });
    }
    signal.throwIfAborted();
    const after = await treeSnapshot(campaign.worktree, campaign.baseCommit);
    if (after.fingerprint !== before.fingerprint)
      throw new Error("Working tree changed during verification; rerun checks on the final tree");
    const input = {
      goal: campaign.goal,
      plan: campaign.plan,
      constraints: campaign.constraints,
      criteria: campaign.acceptance.criteria,
      diff: after.diff,
      checks: evidence.checks,
    };
    evidence.workflowReview = validate(ReviewSchema, await reviewers.workflow(input, signal));
    signal.throwIfAborted();
    if ((await treeSnapshot(campaign.worktree)).fingerprint !== before.fingerprint)
      throw new Error("Working tree changed during workflow review");
    if (evidence.checks.some((check) => check.exitCode !== 0))
      throw new Error("Required checks failed");
    // The fixed evaluator never sees the learned review's verdict or prompts.
    evidence.review = validate(ReviewSchema, await reviewers.acceptance(input, signal));
    signal.throwIfAborted();
    if ((await treeSnapshot(campaign.worktree)).fingerprint !== before.fingerprint)
      throw new Error("Working tree changed during review");
    evidence.passed =
      evidence.workflowReview.completeness &&
      evidence.workflowReview.correctness &&
      evidence.workflowReview.maintainability &&
      evidence.review.completeness &&
      evidence.review.correctness &&
      evidence.review.maintainability;
  } catch (error) {
    evidence.error = String(error);
  }
  await writeFile(evidence.artifactPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  return evidence;
}
export async function evidenceCurrent(campaign: Campaign): Promise<boolean> {
  return (
    campaign.evidence?.passed === true &&
    campaign.evidence.fingerprint === (await treeSnapshot(campaign.worktree)).fingerprint
  );
}
