import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Campaign, type Evidence, ReviewSchema, validate } from "../state/contracts.js";
import { run } from "./process.js";
import { treeSnapshot } from "./workspace.js";

export type Reviewer = (
  input: {
    goal: string;
    constraints: string[];
    criteria: string[];
    diff: string;
    checks: Evidence["checks"];
  },
  signal: AbortSignal,
) => Promise<unknown>;
export async function verify(
  campaign: Campaign,
  artifacts: string,
  reviewer: Reviewer,
  signal: AbortSignal,
): Promise<Evidence> {
  const directory = join(artifacts, randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const before = await treeSnapshot(campaign.worktree, campaign.baseCommit);
  const evidence: Evidence = {
    schema: "pi-dspy-gepa.evidence.v1",
    fingerprint: before.fingerprint,
    checks: [],
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
    if (evidence.checks.some((check) => check.exitCode !== 0))
      throw new Error("Required checks failed");
    evidence.review = validate(
      ReviewSchema,
      await reviewer(
        {
          goal: campaign.goal,
          constraints: campaign.constraints,
          criteria: campaign.acceptance.criteria,
          diff: after.diff,
          checks: evidence.checks,
        },
        signal,
      ),
    );
    if ((await treeSnapshot(campaign.worktree)).fingerprint !== before.fingerprint)
      throw new Error("Working tree changed during review");
    evidence.passed =
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
