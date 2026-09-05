import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { git } from "../src/campaign/process.js";
import { evidenceCurrent } from "../src/campaign/verification.js";
import { startCampaign } from "../src/campaign/workspace.js";
import { disposableCopy } from "../src/learning/copies.js";
import { AllowanceMeter, runExperiment } from "../src/learning/experiment.js";
import { IdleLearning } from "../src/learning/scheduler.js";
import { runTrial, feedback } from "../src/learning/trial.js";
import type { EvaluationCase, Trial } from "../src/state/contracts.js";
import { Store } from "../src/state/store.js";
import { fixture, FakeWorker, call, review } from "./helpers.js";
import { runtimeFixture } from "./runtime-fixture.js";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function cases(f: Awaited<ReturnType<typeof fixture>>): EvaluationCase[] {
  return (["training", "validation", "heldOut"] as const).map((role) => ({
    schema: "pi-dspy-gepa.evaluation-case.v1",
    id: role,
    role,
    repository: f.repository,
    startingCommit: f.campaign.baseCommit,
    task: "Finish source",
    setup: [],
    acceptance: { criteria: ["Finished"], commands: ["true"] },
    rubric: "Complete, correct, simple",
  }));
}
const allowance = { maxTrials: 3, maxModelCalls: 3, concurrency: 2, trialDeadlineMs: 10000 };
it("exports the starting tree without future history or reference patches", async () => {
  const f = await setup();
  await writeFile(join(f.repository, "future-solution"), "must be hidden");
  await git(f.repository, "add", ".");
  await git(f.repository, "-c", "commit.gpgsign=false", "commit", "-qm", "test: future answer");
  const future = await git(f.repository, "rev-parse", "HEAD");
  const copy = await disposableCopy(f.repository, f.campaign.baseCommit);
  try {
    await expect(readFile(join(copy.repository, "future-solution"))).rejects.toThrow();
    await expect(git(copy.repository, "show", future)).rejects.toThrow();
    expect((await git(copy.repository, "rev-list", "--all")).split("\n")).toHaveLength(1);
  } finally {
    await copy.close();
  }
  await expect(disposableCopy(f.repository, "nonexistent")).rejects.toThrow();
});
it("exports pinned submodule source from a local repository", async () => {
  const f = await setup();
  const sub = await setup();
  await git(
    f.repository,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    sub.repository,
    "lib",
  );
  await git(f.repository, "-c", "commit.gpgsign=false", "commit", "-qam", "test: pin submodule");
  const copy = await disposableCopy(f.repository, "HEAD");
  try {
    expect(await readFile(join(copy.repository, "lib", "source.txt"), "utf8")).toBe("starting\n");
    expect(await git(copy.repository, "ls-files", "lib/source.txt")).toBe("lib/source.txt");
    await expect(readFile(join(copy.repository, "lib", ".git"))).rejects.toThrow();
  } finally {
    await copy.close();
  }
});
it("validates and freezes cases and keeps held-out cases out of optimization", async () => {
  const f = await setup();
  for (const value of cases(f)) f.store.addCase(value);
  f.store.addCase(cases(f)[0]!);
  expect(f.store.cases()).toHaveLength(3);
  expect(() => f.store.addCase({ ...cases(f)[0]!, task: "changed" })).toThrow("immutable");
  const worker = new FakeWorker([
    async (payload) => {
      expect(JSON.stringify(payload)).not.toContain("heldOut");
      return { candidates: [{ instructions: "new", demonstrations: [] }] };
    },
  ]);
  const options = {
    store: f.store,
    repository: f.repository,
    candidate: f.candidate,
    allowance,
    cases: cases(f),
    signal: new AbortController().signal,
    idle: () => true,
    reflect: async () => ({ text: "proposal" }),
    worker,
  };
  const result = await runExperiment(options);
  expect(result.candidates).toHaveLength(1);
  expect(f.store.defaultCandidate(f.repository)).toBeUndefined();
  expect((await runExperiment(options)).repeated).toBe(true);
  expect(worker.calls).toHaveLength(1);
  await expect(runExperiment({ ...options, cases: [cases(f)[0]!] })).rejects.toThrow(
    "training and validation",
  );
});
it("enforces trial and model admission allowances with configured parallelism", async () => {
  const f = await setup();
  let active = 0;
  let maximum = 0;
  const trialRunner = async (options: Parameters<typeof runTrial>[0]): Promise<Trial> => {
    options.beforeModelCall();
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return {
      schema: "pi-dspy-gepa.trial.v1",
      id: options.case.id,
      experimentId: options.experimentId,
      candidateId: f.campaign.candidateId,
      caseId: options.case.id,
      status: "completed",
      score: 0,
      evidence: null,
      tracePath: join(f.root, "missing"),
      tokens: 20,
      cost: null,
      durationMs: 10,
      error: null,
    };
  };
  const worker = new FakeWorker([
    async (_payload, exchange, signal) => {
      const outcomes = await exchange(
        "evaluate",
        {
          cases: cases(f).slice(0, 2),
          components: { instructions: "learned", demonstrations: [] },
        },
        signal,
      );
      expect(outcomes).toHaveLength(2);
      expect(await exchange("reflection", { prompt: "improve" }, signal)).toEqual({
        text: "proposal",
      });
      return { candidates: [] };
    },
  ]);
  const result = await runExperiment({
    store: f.store,
    repository: f.repository,
    candidate: f.candidate,
    allowance,
    cases: cases(f),
    signal: new AbortController().signal,
    idle: () => true,
    reflect: async () => ({ text: "proposal" }),
    worker,
    trialRunner,
  });
  expect(result).toMatchObject({ trials: 2, modelCalls: 3 });
  expect(maximum).toBe(2);
  expect(f.store.trials()).toHaveLength(2);
  const meter = new AllowanceMeter({ ...allowance, maxTrials: 1, maxModelCalls: 1 });
  meter.admit();
  meter.modelCall();
  expect(() => meter.admit()).toThrow("trial allowance");
  expect(() => meter.modelCall()).toThrow("model-call allowance");
  expect(() => new AllowanceMeter({ ...allowance, trialDeadlineMs: 0 })).toThrow(
    "Invalid structured",
  );
});
it.each([
  "active",
  "heldOut",
  "unknown-operation",
  "contract-change",
  "invalid-candidate",
  "exhausted",
])("rejects learning %s", async (reason) => {
  const f = await setup();
  const worker = new FakeWorker([
    async (_payload, exchange, signal) => {
      if (reason === "unknown-operation") return exchange("execute-code", {}, signal);
      if (reason === "contract-change")
        return { candidates: [{ instructions: "x", demonstrations: [], programId: "evil" }] };
      return exchange(
        "evaluate",
        {
          cases: reason === "heldOut" ? [cases(f)[2]] : cases(f).slice(0, 2),
          components:
            reason === "invalid-candidate"
              ? { instructions: "x", demonstrations: [], code: "evil" }
              : { instructions: "x", demonstrations: [] },
        },
        signal,
      );
    },
  ]);
  const trialRunner = vi.fn(
    async (options: Parameters<typeof runTrial>[0]): Promise<Trial> => ({
      schema: "pi-dspy-gepa.trial.v1",
      id: "single",
      experimentId: options.experimentId,
      candidateId: f.campaign.candidateId,
      caseId: "training",
      status: "completed",
      score: 0,
      evidence: null,
      tracePath: "missing",
      tokens: 0,
      cost: null,
      durationMs: 0,
      error: null,
    }),
  );
  await expect(
    runExperiment({
      store: f.store,
      repository: f.repository,
      candidate: f.candidate,
      allowance: { ...allowance, maxTrials: 1 },
      cases: cases(f),
      signal: new AbortController().signal,
      idle: () => reason !== "active",
      reflect: async () => ({ text: "x" }),
      worker,
      trialRunner,
    }),
  ).rejects.toThrow();
});
it.each(["pass", "check-fail", "review-fail", "review-malformed", "setup-fail", "cancelled"])(
  "evaluates %s through the same real Pi campaign runtime",
  async (kind) => {
    const f = await setup();
    const services = await runtimeFixture(f.root);
    const value = {
      ...cases(f)[0]!,
      setup: kind === "setup-fail" ? ["exit 4"] : ["printf setup"],
      acceptance: { criteria: ["Goal"], commands: [kind === "check-fail" ? "exit 1" : "true"] },
    };
    const worker = new FakeWorker([
      call("campaign", { action: "complete" }),
      call("campaign", { action: "blocker", text: "Checks or review need fixes" }),
    ]);
    const artifacts = join(f.root, 'trials"quoted');
    const result = await runTrial({
      experimentId: "experiment",
      candidate: f.candidate,
      case: value,
      artifacts,
      signal: kind === "cancelled" ? AbortSignal.abort() : AbortSignal.timeout(15000),
      beforeModelCall: () => {},
      sessionOptions: {
        ...services,
        worker,
        reviewer: async () =>
          kind === "review-malformed" ? {} : { ...review, maintainability: kind !== "review-fail" },
      },
    });
    if (kind === "pass") {
      expect(result.score).toBe(1);
      expect(await readFile(result.tracePath, "utf8")).toContain("complete");
      expect(await readFile(result.evidence!.checks[0]!.outputPath, "utf8")).toBe("");
      const retained = new Store(join(artifacts, result.id, "state", "state.sqlite"));
      try {
        const campaign = retained.campaigns()[0]!;
        expect(campaign.evidence).toEqual(result.evidence);
        expect(await readFile(campaign.sessionPath!, "utf8")).toContain("complete");
        expect(await readFile(join(campaign.worktree, "source.txt"), "utf8")).toBe("starting\n");
        expect(await evidenceCurrent(campaign)).toBe(true);
      } finally {
        retained.close();
      }
    } else if (kind === "check-fail") expect(result.score).toBe(0);
    else if (kind === "review-fail") expect(result.score).toBeCloseTo(2 / 3);
    else expect(result.score).toBeNull();
    expect(await feedback(result)).toContain("evidence");
    expect(await readFile(join(f.repository, "source.txt"), "utf8")).toBe("starting\n");
  },
);
it.each(["decision", "shutdown"])(
  "retains evidence but does not score a trial cancelled during %s",
  async (when) => {
    const f = await setup();
    const services = await runtimeFixture(f.root);
    const abort = new AbortController();
    const worker = new FakeWorker([
      call("campaign", { action: when === "decision" ? "verify" : "complete" }),
      async () => {
        abort.abort(new Error("Trial cancelled"));
        throw abort.signal.reason;
      },
    ]);
    if (when === "shutdown")
      worker.close = async () => {
        abort.abort(new Error("Trial cancelled"));
      };
    const result = await runTrial({
      experimentId: "experiment",
      candidate: f.candidate,
      case: cases(f)[0]!,
      artifacts: join(f.root, "trials"),
      signal: abort.signal,
      beforeModelCall: () => {},
      sessionOptions: { ...services, worker, reviewer: async () => review },
    });
    expect(result).toMatchObject({
      status: "cancelled",
      score: null,
      error: "Error: Trial cancelled",
    });
    expect(result.evidence?.passed).toBe(true);
    expect(await feedback(result)).toContain("Trial cancelled");
  },
);
it("keeps final source and paths when session cleanup fails", async () => {
  const f = await setup();
  const services = await runtimeFixture(f.root);
  const worker = new FakeWorker([
    call("write", { path: "source.txt", content: "surviving work" }),
    call("campaign", { action: "complete" }),
  ]);
  worker.close = async () => {
    throw new Error("Cleanup failed");
  };
  const artifacts = join(f.root, "trials");
  const result = await runTrial({
    experimentId: "experiment",
    candidate: f.candidate,
    case: cases(f)[0]!,
    artifacts,
    signal: AbortSignal.timeout(15000),
    beforeModelCall: () => {},
    sessionOptions: { ...services, worker, reviewer: async () => review },
  });
  expect(result).toMatchObject({ status: "error", score: null, error: "Error: Cleanup failed" });
  const retained = new Store(join(artifacts, result.id, "state", "state.sqlite"));
  try {
    const campaign = retained.campaigns()[0]!;
    expect(await readFile(join(campaign.worktree, "source.txt"), "utf8")).toBe("surviving work");
    expect(await evidenceCurrent(campaign)).toBe(true);
    expect(await readFile(result.tracePath, "utf8")).toContain("surviving work");
    expect(JSON.parse(await readFile(join(artifacts, result.id, "trial.json"), "utf8"))).toEqual(
      result,
    );
  } finally {
    retained.close();
  }
});
it("cancels an in-flight experiment when another connection resumes a repository campaign", async () => {
  const f = await setup();
  f.control.pause();
  const other = await startCampaign(f.store, {
    repository: f.repository,
    goal: "Other work",
    candidateId: f.campaign.candidateId,
  });
  other.status = "paused";
  f.store.saveCampaign(other);
  const connection = new Store(f.store.filePath);
  const abort = new AbortController();
  let trialSignal: AbortSignal | undefined;
  const worker = new FakeWorker([
    async (_payload, exchange, signal) => {
      await exchange(
        "evaluate",
        {
          cases: [cases(f)[0]],
          components: { instructions: "learned", demonstrations: [] },
        },
        signal,
      );
      return { candidates: [] };
    },
  ]);
  const running = runExperiment({
    store: f.store,
    repository: f.repository,
    candidate: f.candidate,
    allowance,
    cases: cases(f),
    signal: abort.signal,
    idle: () =>
      f.store
        .campaigns()
        .filter((value) => value.repository === f.repository)
        .every((value) => ["paused", "completed", "cancelled"].includes(value.status)),
    reflect: async () => ({ text: "unused" }),
    worker,
    trialRunner: async (options) => {
      trialSignal = options.signal;
      await new Promise<void>((resolve) =>
        options.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return {
        schema: "pi-dspy-gepa.trial.v1",
        id: "interrupted",
        experimentId: options.experimentId,
        candidateId: f.campaign.candidateId,
        caseId: options.case.id,
        status: "cancelled",
        score: null,
        evidence: null,
        tracePath: join(f.root, "missing"),
        tokens: 0,
        cost: null,
        durationMs: 0,
        error: "cancelled",
      };
    },
  });
  const rejected = expect(running).rejects.toThrow("completed or paused");
  try {
    await vi.waitFor(() => expect(trialSignal).toBeDefined());
    other.status = "active";
    connection.saveCampaign(other); // No local CampaignControl event reaches the experiment.
    await rejected;
    expect(trialSignal?.aborted).toBe(true);
    expect(f.store.trials()).toMatchObject([{ status: "cancelled" }]);
    expect(f.store.experiments()).toMatchObject([{ result: { status: "cancelled" } }]);
  } finally {
    abort.abort();
    await running.catch(() => {});
    connection.close();
  }
});
it("starts only at idle, cancels trials when live work resumes, and waits for cleanup on exit", async () => {
  const f = await setup();
  const started = vi.fn();
  const stopped = vi.fn();
  const scheduler = new IdleLearning(
    f.control,
    async (signal) => {
      started();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            stopped();
            resolve();
          },
          { once: true },
        );
      });
    },
    () => {},
  );
  scheduler.update();
  expect(started).not.toHaveBeenCalled();
  f.control.pause();
  await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
  scheduler.update();
  expect(started).toHaveBeenCalledTimes(1);
  f.control.continue();
  await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1));
  await scheduler.close();
  f.control.pause();
  scheduler.update();
  expect(started).toHaveBeenCalledTimes(1);
});
it("does not admit learning until a paused live action has actually settled", async () => {
  const f = await setup();
  let settled = false;
  const experiment = vi.fn(async () => {});
  const scheduler = new IdleLearning(
    f.control,
    experiment,
    () => {},
    () => settled,
  );
  f.control.pause();
  await new Promise((resolve) => setImmediate(resolve));
  expect(experiment).not.toHaveBeenCalled();
  settled = true;
  scheduler.update();
  await vi.waitFor(() => expect(experiment).toHaveBeenCalledOnce());
  await scheduler.close();
});
