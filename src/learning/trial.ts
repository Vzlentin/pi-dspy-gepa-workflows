import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../campaign/process.js";
import { startCampaign, treeSnapshot } from "../campaign/workspace.js";
import { openCampaign, type SessionOptions } from "../runtime/session.js";
import {
  type Candidate,
  type EvaluationCase,
  type Trial,
  LOCAL_AUTHORITY,
  candidateId,
} from "../state/contracts.js";
import { Store } from "../state/store.js";
import { disposableCopy } from "./copies.js";

export type TrialOptions = {
  experimentId: string;
  candidate: Candidate;
  case: EvaluationCase;
  artifacts: string;
  signal: AbortSignal;
  beforeModelCall: () => void;
  sessionOptions?: Partial<SessionOptions>;
};
export type TrialRunner = (options: TrialOptions) => Promise<Trial>;
export const runTrial: TrialRunner = async (options) => {
  const began = Date.now();
  const id = randomUUID();
  const artifacts = join(options.artifacts, id);
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const trial: Trial = {
    schema: "pi-dspy-gepa.trial.v1",
    id,
    experimentId: options.experimentId,
    candidateId: candidateId(options.candidate),
    caseId: options.case.id,
    status: "error",
    score: null,
    evidence: null,
    tracePath: artifacts,
    tokens: 0,
    cost: null,
    durationMs: 0,
    error: null,
  };
  let session: Awaited<ReturnType<typeof openCampaign>> | undefined;
  let copy: Awaited<ReturnType<typeof disposableCopy>> | undefined;
  let store: Store | undefined;
  try {
    options.signal.throwIfAborted();
    copy = await disposableCopy(options.case.repository, options.case.startingCommit);
    store = new Store(join(copy.root, "state", "state.sqlite"));
    store.addCandidate(options.candidate);
    const campaign = await startCampaign(store, {
      repository: copy.repository,
      goal: options.case.task,
      candidateId: trial.candidateId,
      authority: { ...LOCAL_AUTHORITY },
      constraints: [
        options.case.rubric,
        "Evaluation: only edit this worktree. No network retrieval of task solutions or reference patches. Do not access other repositories.",
      ],
    });
    campaign.acceptance = options.case.acceptance;
    trial.tracePath = join(artifacts, "state", "campaigns", campaign.id, "dspy-traces.jsonl");
    store.saveCampaign(campaign);
    for (const [index, command] of options.case.setup.entries()) {
      const result = await run("/bin/sh", ["-c", command], campaign.worktree, {
        signal: options.signal,
        outputPath: join(artifacts, `setup-${index}.log`),
      });
      if (result.exitCode !== 0) throw new Error(`Case setup failed: ${result.output}`);
    }
    session = await openCampaign({
      ...options.sessionOptions,
      store,
      campaign,
      candidate: options.candidate,
      beforeModelCall: options.beforeModelCall,
      signal: options.signal,
    });
    await session.runHeadless(options.signal);
    trial.evidence = campaign.evidence;
    if (campaign.evidence?.checks.some((check) => check.exitCode !== 0)) trial.score = 0;
    else if (campaign.evidence?.review && !campaign.evidence.error) {
      if (campaign.evidence.fingerprint !== (await treeSnapshot(campaign.worktree)).fingerprint)
        throw new Error("Stale completion evidence");
      const review = campaign.evidence.review;
      trial.score =
        [review.completeness, review.correctness, review.maintainability].filter(Boolean).length /
        3;
    } else
      throw new Error(
        campaign.result ?? campaign.evidence?.error ?? "Missing independent review evidence",
      );
    trial.status = "completed";
  } catch (error) {
    trial.status = options.signal.aborted ? "cancelled" : "error";
    trial.score = null;
    trial.error = String(error);
  } finally {
    try {
      await session?.close();
    } catch (error) {
      trial.status = "error";
      trial.score = null;
      trial.error = String(error);
    }
    if (session) {
      trial.tokens = session.ledger.usage.totalTokens;
      trial.cost = session.ledger.calls ? session.ledger.usage.cost.total : null;
    }
    // Preserve even partial traces and failed-run evidence.
    try {
      if (store) {
        store.close();
        await cp(store.root, join(artifacts, "state"), { recursive: true });
        if (trial.evidence) {
          trial.evidence = JSON.parse(
            JSON.stringify(trial.evidence).replaceAll(store.root, join(artifacts, "state")),
          ) as NonNullable<Trial["evidence"]>;
          await writeFile(trial.evidence.artifactPath, JSON.stringify(trial.evidence, null, 2));
        }
      }
    } finally {
      await copy?.close();
    }
    trial.durationMs = Date.now() - began;
  }
  await writeFile(join(artifacts, "trial.json"), JSON.stringify(trial, null, 2), { mode: 0o600 });
  return trial;
};
export async function feedback(trial: Trial): Promise<string> {
  let traces = "";
  try {
    traces = await readFile(trial.tracePath, "utf8");
  } catch {
    /* Error trials may not have produced a decision. */
  }
  const checks = await Promise.all(
    (trial.evidence?.checks ?? []).map(async (check) => ({
      ...check,
      output: await readFile(check.outputPath, "utf8"),
    })),
  );
  return JSON.stringify({ evidence: trial.evidence, checks, error: trial.error, traces });
}
