import { mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CampaignControl } from "../src/campaign/control.js";
import { UsageLedger } from "../src/runtime/accounting.js";
import { seedCandidate } from "../src/runtime/policy.js";
import { Store } from "../src/state/store.js";
import { fixture, assistant, model, review } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  run: vi.fn(),
  experiment: vi.fn(),
  bootstrap: vi.fn(),
}));
vi.mock("../src/runtime/session.js", () => ({ openCampaign: mocks.open }));
vi.mock("../src/learning/experiment.js", () => ({ runExperiment: mocks.experiment }));
vi.mock("../src/learning/historical.js", () => ({ bootstrap: mocks.bootstrap }));
import { loadConfig } from "../src/launcher/config.js";
import { launch } from "../src/launcher/launch.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mocks.open.mockReset();
  mocks.run.mockReset();
  mocks.experiment.mockReset();
  mocks.bootstrap.mockReset();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup() {
  const f = await fixture();
  cleanups.push(() => f.close());
  vi.stubEnv("HERDR_ENV", undefined);
  const state = join(f.root, "launcher", "state.sqlite");
  const completeSimple = vi.fn(async () => assistant("proposal"));
  mocks.open.mockImplementation(async (options) => {
    const control = new CampaignControl(
      options.store,
      options.campaign,
      async () => review,
      join(f.root, "artifacts"),
    );
    return {
      control,
      services: { modelRuntime: { completeSimple } },
      model,
      ledger: new UsageLedger(),
      run: mocks.run,
      close: vi.fn(async () => control.pause()),
    };
  });
  return { ...f, state, completeSimple, args: ["--state", state] };
}
it("parses configuration and rejects unknown authority fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "campaign-config-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  expect(await loadConfig()).toEqual({ schema: "pi-dspy-gepa.launch.v1" });
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ schema: "pi-dspy-gepa.launch.v1", unauthorized: true }));
  await expect(loadConfig(path)).rejects.toThrow("Invalid structured");
  await writeFile(
    path,
    JSON.stringify({
      schema: "pi-dspy-gepa.launch.v1",
      allowance: { maxTrials: 1, trialDeadlineMs: 1000, maxModelCalls: 1 },
    }),
  );
  expect((await loadConfig(path)).allowance?.concurrency).toBe(1);
});
it("shows help, validates arguments, prints status and bootstraps explicit repositories", async () => {
  const f = await setup();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await launch([]);
  await launch(["--help"]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("campaign start"));
  for (const args of [
    ["bogus"],
    ["start"],
    ["start", "--repo", ".", "--goal", "x"],
    ["resume", "unknown"],
    ["approve", "id"],
    ["bootstrap"],
  ])
    await expect(launch([...args, ...f.args])).rejects.toThrow();
  mocks.bootstrap.mockResolvedValue({ validated: true });
  await launch(["bootstrap", "--repo", f.repository, ...f.args]);
  expect(mocks.bootstrap).toHaveBeenCalled();
  await launch(["status", ...f.args]);
});
it.each(["absolute", "relative", "bare"])(
  "reads the complete goal from a %s file path",
  async (kind) => {
    const f = await setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "cwd").mockReturnValue(f.root);
    const text = "Ship the feature.\n\nKeep all constraints.\n";
    const file = join(f.root, "campaign goal.md");
    await writeFile(file, text);
    const goal =
      kind === "absolute" ? file : kind === "relative" ? "./campaign goal.md" : "campaign goal.md";
    await launch(["start", "--repo", f.repository, "--goal", goal, ...f.args]);
    expect(mocks.open.mock.calls[0]![0].campaign.goal).toBe(text);
    await writeFile(file, "Changed after launch");
    const db = new Store(f.state);
    try {
      expect(db.campaigns()[0]!.goal).toBe(text);
    } finally {
      db.close();
    }
  },
);
it.each(["Implement change", "Update src/launcher/launch.ts", "Full goal.\n".repeat(1000)])(
  "preserves literal goals (%#)",
  async (goal) => {
    const f = await setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await launch(["start", "--repo", f.repository, "--goal", goal, ...f.args]);
    expect(mocks.open.mock.calls[0]![0].campaign.goal).toBe(goal);
  },
);
it("rejects missing explicit paths, directories and empty goals before creating a campaign", async () => {
  const f = await setup();
  vi.spyOn(process, "cwd").mockReturnValue(f.root);
  const empty = join(f.root, "empty.md");
  await writeFile(empty, " \n\t");
  for (const goal of [
    join(f.root, "missing.md"),
    "./missing.md",
    "../missing.md",
    f.root,
    empty,
    " \n",
  ]) {
    await expect(
      launch(["start", "--repo", f.repository, "--goal", goal, ...f.args]),
    ).rejects.toThrow();
  }
  expect(mocks.open).not.toHaveBeenCalled();
  const db = new Store(f.state);
  try {
    expect(db.campaigns()).toEqual([]);
  } finally {
    db.close();
  }
});
it("launches a committed worktree with an explicit contract and human-only approval", async () => {
  const f = await setup();
  const config = join(f.root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      schema: "pi-dspy-gepa.launch.v1",
      acceptance: { criteria: ["Goal"], commands: ["true"] },
      constraints: ["Only local edits"],
      authority: f.campaign.authority,
      allowance: { maxTrials: 1, trialDeadlineMs: 1000, concurrency: 1, maxModelCalls: 1 },
    }),
  );
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await launch([
    "start",
    "--repo",
    f.repository,
    "--goal",
    "Implement change",
    "--base",
    "HEAD",
    "--config",
    config,
    ...f.args,
  ]);
  expect(mocks.run).toHaveBeenCalledOnce();
  expect(mocks.open.mock.calls[0]![0]).toMatchObject({ resume: false });
  expect("herdrPane" in mocks.open.mock.calls[0]![0]).toBe(false);
  expect(log).toHaveBeenCalledWith("Campaign active.");
  expect(mocks.experiment).not.toHaveBeenCalled();
  const db = new Store(f.state);
  const campaign = db.campaigns()[0]!;
  const learned = seedCandidate();
  learned.stages.plan.instructions = "New default";
  const learnedId = db.addCandidate(learned);
  db.close();
  expect(campaign.authority.merge).toBe(false);
  expect(campaign.acceptance?.commands).toEqual(["true"]);
  expect(campaign.status).toBe("paused");
  await launch(["approve", learnedId, "--repo", f.repository, ...f.args]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("remain pinned"));
  await launch(["learning", ...f.args]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("trials"));
  await launch(["status", ...f.args]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('"evidenceCurrent":false'));
  const reopened = new Store(f.state);
  expect(reopened.defaultCandidate(f.repository)).toBe(learnedId);
  expect(reopened.campaigns()[0]!.candidateId).not.toBe(learnedId);
  reopened.close();
});
it.each(["root", "subdirectory", "symlink"])(
  "selects the approved candidate using canonical repository identity from %s",
  async (kind) => {
    const f = await setup();
    const db = new Store(f.state);
    const learned = seedCandidate();
    learned.repository = f.repository;
    learned.stages.plan.instructions = "Approved repository policy";
    const id = db.addCandidate(learned);
    db.approve(f.repository, id);
    db.close();
    const subdirectory = join(f.repository, "nested");
    const alias = join(f.root, "alias");
    await mkdir(subdirectory);
    await symlink(f.repository, alias);
    const repository = kind === "root" ? f.repository : kind === "symlink" ? alias : subdirectory;
    await launch(["start", "--repo", repository, "--goal", "Goal", ...f.args]);
    expect(mocks.open.mock.calls.at(-1)![0].campaign).toMatchObject({
      repository: f.repository,
      candidateId: id,
    });
  },
);
it("runs stages in Herdr panes beside the launcher only inside Herdr", async () => {
  const f = await setup();
  vi.stubEnv("HERDR_ENV", "1");
  vi.stubEnv("HERDR_PANE_ID", "w1:p7");
  await launch(["start", "--repo", f.repository, "--goal", "Goal", ...f.args]);
  expect(mocks.open.mock.calls.at(-1)![0].herdrPane).toBe("w1:p7");
});
it("resumes explicitly and rejects contract replacement and terminal campaigns", async () => {
  const f = await setup();
  await launch(["start", "--repo", f.repository, "--goal", "Goal", ...f.args]);
  const db = new Store(f.state);
  const campaign = db.campaigns()[0]!;
  db.close();
  await launch(["resume", campaign.id, ...f.args]);
  expect(mocks.open.mock.calls.at(-1)![0].resume).toBe(true);
  const config = join(f.root, "config.json");
  await writeFile(
    config,
    JSON.stringify({ schema: "pi-dspy-gepa.launch.v1", constraints: ["changed"] }),
  );
  await expect(launch(["resume", campaign.id, "--config", config, ...f.args])).rejects.toThrow(
    "cannot replace",
  );
  const terminal = new Store(f.state);
  campaign.status = "completed";
  terminal.saveCampaign(campaign);
  terminal.close();
  await expect(launch(["resume", campaign.id, ...f.args])).rejects.toThrow("start a new");
});
it("learns after a completed campaign within the allowance using Pi model reflection", async () => {
  const f = await setup();
  const config = join(f.root, "learning.json");
  const casesFile = join(f.root, "cases.json");
  await writeFile(casesFile, "[]");
  await writeFile(
    config,
    JSON.stringify({
      schema: "pi-dspy-gepa.launch.v1",
      allowance: { maxTrials: 1, trialDeadlineMs: 1000, concurrency: 1, maxModelCalls: 1 },
      casesFile,
    }),
  );
  mocks.experiment.mockImplementation(async (options) => {
    expect(options.idle()).toBe(true);
    expect(options.cases).toEqual([]);
    expect(await options.reflect("reflect", new AbortController().signal)).toEqual({
      text: "proposal",
    });
    expect(await options.reflect({ structured: true }, new AbortController().signal)).toEqual({
      text: "proposal",
    });
    return { candidates: ["learned"] };
  });
  mocks.run.mockImplementation(async () => {
    const live = await mocks.open.mock.results.at(-1)!.value;
    live.control.campaign.status = "completed";
    live.control.campaign.result = "Shipped";
    live.control.changed();
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await launch(["start", "--repo", f.repository, "--goal", "Goal", "--config", config, ...f.args]);
  expect(f.completeSimple).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('"candidates":["learned"]'));
  expect(log).toHaveBeenCalledWith("Campaign completed.\nShipped");
  f.completeSimple.mockResolvedValueOnce({ ...assistant(""), stopReason: "error" });
  const options = mocks.experiment.mock.calls[0]![0];
  await expect(options.reflect("again", new AbortController().signal)).rejects.toThrow(
    "GEPA reflection failed",
  );
});
