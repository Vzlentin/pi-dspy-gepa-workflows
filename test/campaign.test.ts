import { readFile, writeFile, symlink, chmod, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run, git } from "../src/campaign/process.js";
import { verify, evidenceCurrent } from "../src/campaign/verification.js";
import {
  ownerAlive,
  ownerToken,
  repositoryRoot,
  startCampaign,
  treeSnapshot,
} from "../src/campaign/workspace.js";
import { CandidateSchema, validate, candidateId, digest } from "../src/state/contracts.js";
import { Store, statePath } from "../src/state/store.js";
import { fixture, plan, report, review } from "./helpers.js";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() {
  const value = await fixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const value of fixtures.splice(0)) await value.close();
});
describe("campaign state and contracts", () => {
  it.each([undefined, "", "relative/state", "/absolute/state"])(
    "resolves XDG state home %s without using the Pi agent directory",
    async (xdg) => {
      const f = await setup();
      vi.stubEnv("HOME", join(f.root, "home"));
      vi.stubEnv("XDG_STATE_HOME", xdg);
      expect(statePath()).toBe(
        join(
          xdg === "/absolute/state" ? xdg : join(f.root, "home", ".local", "state"),
          "pi-dspy-gepa-workflows",
          "state.sqlite",
        ),
      );
    },
  );
  it("creates default state and private run folders under XDG state home", async () => {
    const f = await setup();
    vi.stubEnv("XDG_STATE_HOME", join(f.root, "xdg"));
    const store = new Store();
    try {
      const campaign = await startCampaign(store, {
        repository: f.repository,
        goal: "Isolated XDG run",
        candidateId: store.addCandidate(f.candidate),
      });
      const directory = join(f.root, "xdg", "pi-dspy-gepa-workflows", "runs", campaign.id);
      expect(campaign.worktree).toBe(join(directory, "worktree"));
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
      const reopened = new Store();
      try {
        expect(reopened.getCampaign(campaign.id)).toEqual(campaign);
        expect(reopened.runPath(campaign.id)).toBe(directory);
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
    }
  });
  it("isolates committed HEAD and preserves dirty original source", async () => {
    const f = await setup();
    await writeFile(join(f.repository, "source.txt"), "uncommitted");
    await writeFile(join(f.repository, "untracked"), "secret");
    const next = await startCampaign(f.store, {
      repository: f.repository,
      goal: "Task",
      candidateId: f.campaign.candidateId,
      base: "HEAD",
      constraints: ["no network"],
    });
    expect(await readFile(join(next.worktree, "source.txt"), "utf8")).toBe("starting\n");
    await expect(readFile(join(next.worktree, "untracked"))).rejects.toThrow();
    expect(await readFile(join(f.repository, "source.txt"), "utf8")).toBe("uncommitted");
    expect(next.authority.merge).toBe(false);
    await expect(
      startCampaign(f.store, { repository: ".", goal: "x", candidateId: f.campaign.candidateId }),
    ).rejects.toThrow("absolute");
    await expect(repositoryRoot(".")).rejects.toThrow("absolute");
    await expect(git(f.repository, "rev-parse", "does-not-exist")).rejects.toThrow("failed");
  });
  it("keeps candidates immutable and promotion applies only to future campaigns", async () => {
    const f = await setup();
    const learned = structuredClone(f.candidate);
    learned.stages.implement.instructions = "Try another strategy";
    const id = f.store.addCandidate(learned);
    expect(candidateId(learned)).toBe(id);
    expect(f.store.addCandidate(learned)).toBe(id);
    expect(f.store.defaultCandidate(f.repository)).toBeUndefined();
    f.store.approve(f.repository, id);
    expect(f.store.defaultCandidate(f.repository)).toBe(id);
    expect(f.campaign.candidateId).not.toBe(id);
    expect(f.store.candidate(id)).toEqual(learned);
    expect(() => validate(CandidateSchema, { ...learned, code: "evil" })).toThrow();
    expect(() =>
      validate(CandidateSchema, { ...learned, demonstrations: [{ input: {}, action: {} }] }),
    ).toThrow();
    expect(() => f.store.saveCampaign({ ...f.campaign, candidateId: id })).toThrow("immutable");
    expect(() =>
      f.store.saveCampaign({ ...f.campaign, authority: { ...f.campaign.authority, merge: true } }),
    ).toThrow("immutable");
    f.store.db
      .prepare("UPDATE candidates SET data=? WHERE id=?")
      .run(JSON.stringify(learned), f.campaign.candidateId);
    expect(() => f.store.candidate(f.campaign.candidateId)).toThrow("digest mismatch");
    expect(f.store.campaigns()).toHaveLength(1);
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
    const foreign = f.store.addCandidate({ ...learned, repository: "/another/repository" });
    expect(() => f.store.approve(f.repository, foreign)).toThrow("one repository");
    expect(() => f.store.finishExperiment("unknown", {})).toThrow("Unknown experiment");
  });
  it("rejects a candidate from the old Pi runtime with reset guidance and preserves its data", async () => {
    const f = await setup();
    const previous = JSON.stringify({
      ...f.candidate,
      provenance: { ...f.candidate.provenance, pi: "0.84.4" },
    });
    f.store.db
      .prepare("UPDATE candidates SET data=? WHERE id=?")
      .run(previous, f.campaign.candidateId);
    expect(() => f.store.candidate(f.campaign.candidateId)).toThrow("Back up and move");
    expect(
      f.store.db.prepare("SELECT data FROM candidates WHERE id=?").get(f.campaign.candidateId),
    ).toEqual({ data: previous });
  });
  it("opens compatible state and rejects old alpha state without writing it", async () => {
    const f = await setup();
    const second = new Store(f.store.filePath);
    expect(second.campaigns()).toHaveLength(1);
    second.close();
    const path = join(f.root, "old.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE workflows(id TEXT)");
    db.close();
    const before = await readFile(path);
    expect(() => new Store(path)).toThrow("Back up and move");
    expect(await readFile(path)).toEqual(before);
  });
  it("rejects the superseded worktree layout without modifying its database", async () => {
    const f = await setup();
    const path = join(f.root, "old-layout.sqlite");
    const old = new Store(path);
    old.saveCampaign({ ...f.campaign, worktree: join(f.root, "worktrees", f.campaign.id) });
    old.close();
    const before = await readFile(path);
    expect(() => new Store(path)).toThrow("Back up and move");
    expect(await readFile(path)).toEqual(before);
  });
  it("fences owners and reclaims only a dead process without replay", async () => {
    const f = await setup();
    const token = ownerToken();
    expect(ownerAlive(token)).toBe(true);
    f.store.claim(f.campaign.worktree, token, ownerAlive);
    expect(() => f.store.claim(f.campaign.worktree, "other", () => true)).toThrow("live owner");
    f.store.release(f.campaign.worktree, "wrong");
    expect(() => f.store.claim(f.campaign.worktree, token, () => true)).toThrow();
    f.store.claim(f.campaign.worktree, "replacement", () => false);
    f.store.release(f.campaign.worktree, "replacement");
    expect(ownerAlive(JSON.stringify({ host: "another-host", pid: 1 }))).toBe(true);
    expect(
      ownerAlive(
        JSON.stringify({ host: JSON.parse(token).host, pid: 2147483647, start: "absent" }),
      ),
    ).toBe(false);
    expect(ownerAlive(JSON.stringify({ ...JSON.parse(token), start: "wrong" }))).toBe(false);
  });
});
describe("completion and content fingerprints", () => {
  it("keeps full multiline verification evidence readable in the campaign brief", async () => {
    const f = await setup();
    f.campaign.evidence = {
      schema: "pi-dspy-gepa.evidence.v1",
      fingerprint: "fingerprint",
      passed: false,
      artifactPath: join(f.root, "evidence.json"),
      error: "First error line\nSecond error line",
      checks: [
        {
          command: "echo first\necho second",
          exitCode: null,
          outputPath: join(f.root, "check.log"),
        },
      ],
      workflowReview: { ...review, findings: "First finding\nSecond finding" },
      review: null,
    };
    f.campaign.result = "First blocker line\nSecond blocker line";
    const brief = f.control.brief();
    for (const text of [
      f.campaign.evidence.error,
      f.campaign.evidence.workflowReview!.findings,
      f.campaign.evidence.checks[0]!.command,
      f.campaign.evidence.checks[0]!.outputPath,
      f.campaign.result,
    ])
      expect(brief).toContain(text);
    expect(brief).toContain("Exit code: Unavailable");
    expect(brief).toContain("### Independent acceptance\nNot available.");
    expect(brief).not.toContain("\\n");
  });
  it("reviews authorized committed changes against the campaign base", async () => {
    const f = await setup();
    await writeFile(join(f.campaign.worktree, "source.txt"), "finished");
    await git(f.campaign.worktree, "add", ".");
    await git(
      f.campaign.worktree,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "test: authorized local result",
    );
    f.campaign.acceptance = { criteria: ["Finished"], commands: ["true"] };
    let diff = "";
    const result = await verify(
      f.campaign,
      join(f.root, "review-committed"),
      async (input) => {
        diff = input.diff;
        return review;
      },
      new AbortController().signal,
    );
    // Only the host's review stage record can pass evidence.
    expect(result).toMatchObject({ passed: false, error: null, review });
    expect(diff).toContain("+finished");
  });
  it("requires complete immutable acceptance and host evidence", async () => {
    const f = await setup();
    const signal = new AbortController().signal;
    const missing = await verify(f.campaign, join(f.root, "checks"), f.control.evaluator, signal);
    expect(missing.passed).toBe(false);
    expect(missing.error).toContain("Record acceptance");
    f.campaign.stage = "review";
    await expect(f.control.begin(signal)).rejects.toThrow("Record the plan");
    f.campaign.stage = "plan";
    await f.control.begin(signal);
    await expect(f.control.record({ ...plan, plan: " " })).rejects.toThrow("complete plan");
    await expect(f.control.record({ text: "Do work" })).rejects.toThrow("Invalid structured");
    await f.control.record({ ...plan, commands: ["printf full-output"] });
    expect(f.campaign.stage).toBe("implement");
    f.campaign.stage = "plan";
    await expect(f.control.record(plan)).rejects.toThrow("already recorded");
    expect(() => f.store.saveCampaign({ ...f.campaign, plan: "Changed" })).toThrow("immutable");
    f.campaign.stage = "implement";
    await f.control.begin(signal);
    await f.control.record(report);
    await expect(f.control.record(review)).rejects.toThrow("Review requires verification evidence");
    const inputs = await f.control.begin(signal);
    expect(inputs.evidence).toContain("## Check: printf full-output\nExit code: 0");
    expect(inputs.evidence).toContain("full-output");
    expect(inputs.evidence).toContain(`## Complete diff against ${f.campaign.baseCommit}`);
    expect(await f.control.record(review)).toEqual({ status: "completed", stage: "review" });
    expect(f.campaign.result).toBe(review.findings);
    expect(f.campaign.evidence).toMatchObject({ passed: true, workflowReview: review, review });
    expect(await evidenceCurrent(f.campaign)).toBe(true);
    expect(await readFile(f.campaign.evidence!.checks[0]!.outputPath, "utf8")).toBe("full-output");
    await writeFile(join(f.campaign.worktree, "source.txt"), "later edit");
    expect(await evidenceCurrent(f.campaign)).toBe(false);
  });
  it.each([
    "failure",
    "no-authority",
    "malformed",
    "review-fail",
    "mutating-check",
    "mutating-review",
    "cancelled",
  ])("rejects %s evidence", async (kind) => {
    const f = await setup();
    f.campaign.acceptance = {
      criteria: ["Goal"],
      commands: [
        kind === "failure"
          ? "printf failed; exit 3"
          : kind === "mutating-check"
            ? "printf changed > source.txt"
            : "true",
      ],
    };
    if (kind === "no-authority") f.campaign.authority.test = false;
    const abort = new AbortController();
    if (kind === "cancelled") abort.abort();
    const evidence = await verify(
      f.campaign,
      join(f.root, "verify"),
      async () => {
        if (kind === "mutating-review")
          await writeFile(join(f.campaign.worktree, "source.txt"), "changed");
        return kind === "malformed" ? {} : { ...review, correctness: kind !== "review-fail" };
      },
      abort.signal,
    );
    expect(evidence.passed).toBe(false);
    if (kind === "review-fail") expect(evidence.error).toBeNull();
    else if (kind === "mutating-review")
      expect(evidence.error).toContain("changed during independent review");
    else expect(evidence.review).toBeNull();
    expect(await readFile(evidence.artifactPath, "utf8")).toContain('"passed": false');
  });
  it("fingerprints untracked content, executable modes, links, and deletions", async () => {
    const f = await setup();
    const states = [(await treeSnapshot(f.campaign.worktree)).fingerprint];
    const file = join(f.campaign.worktree, "new.txt");
    await writeFile(file, "new");
    states.push((await treeSnapshot(f.campaign.worktree)).fingerprint);
    await chmod(file, 0o755);
    states.push((await treeSnapshot(f.campaign.worktree)).fingerprint);
    await symlink("new.txt", join(f.campaign.worktree, "link"));
    states.push((await treeSnapshot(f.campaign.worktree)).fingerprint);
    await rm(join(f.campaign.worktree, "source.txt"));
    states.push((await treeSnapshot(f.campaign.worktree)).fingerprint);
    expect(new Set(states).size).toBe(states.length);
    expect((await treeSnapshot(f.campaign.worktree)).diff).toContain("Untracked file");
  });
  it("persists report notes, pause, blockers and errors; only the host changes status", async () => {
    const f = await setup();
    const signal = new AbortController().signal;
    let events = 0;
    const unsubscribe = f.control.subscribe(() => events++);
    await f.control.begin(signal);
    await f.control.record(plan);
    await f.control.begin(signal);
    f.control.pause();
    expect(f.campaign.status).toBe("paused");
    f.control.pause();
    // Finished work is recorded even after a pause request; the next begin stops.
    await f.control.record({ summary: "Half done", notes: ["Useful memory"], blocker: "" });
    expect(f.control.brief()).toContain("implement: Half done\n\nUseful memory");
    expect(await f.control.begin(signal)).toEqual({
      status: "paused",
      stage: "review",
      evidence: null,
    });
    f.control.continue();
    f.campaign.stage = "fix";
    await expect(f.control.record({ approve: true })).rejects.toThrow("Invalid structured");
    await f.control.record({ ...report, blocker: "Need task scope" });
    expect(f.campaign).toMatchObject({
      status: "blocked",
      stage: "fix",
      result: "Need task scope",
    });
    f.control.continue();
    f.control.stop("failed", "execution failed");
    expect(f.store.getCampaign(f.campaign.id)?.result).toBe("execution failed");
    await expect(f.control.record(report)).rejects.toThrow("Campaign is failed");
    f.control.stop("cancelled", "user aborted");
    expect(() => f.control.continue()).toThrow("cannot continue");
    unsubscribe();
    expect(events).toBeGreaterThan(3);
  });
  it("retains complete process output and cancels the process group", async () => {
    const f = await setup();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const result = await run("/bin/sh", ["-c", "printf before; sleep 20"], f.root, {
      signal: abort.signal,
    });
    expect(result.output).toBe("before");
    expect(result.exitCode).toBeNull();
    await expect(run("no-such-executable", [], f.root)).rejects.toThrow();
    await expect(run("true", [], f.root, { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
