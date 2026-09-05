import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CampaignControl } from "../src/campaign/control.js";
import { seedCandidate } from "../src/runtime/dispatcher.js";
import { Store } from "../src/state/store.js";
import { fixture, assistant, review } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  run: vi.fn(),
  experiment: vi.fn(),
  bootstrap: vi.fn(),
}));
vi.mock("../src/runtime/session.js", () => ({ openCampaign: mocks.open }));
vi.mock("../src/learning/experiment.js", () => ({ runExperiment: mocks.experiment }));
vi.mock("../src/learning/historical.js", () => ({ bootstrap: mocks.bootstrap }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  InteractiveMode: class {
    async run() {
      await mocks.run();
    }
  },
}));
import { loadConfig } from "../src/launcher/config.js";
import { launch } from "../src/launcher/launch.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  mocks.open.mockReset();
  mocks.run.mockReset();
  mocks.experiment.mockReset();
  mocks.bootstrap.mockReset();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup() {
  const f = await fixture();
  cleanups.push(() => f.close());
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
      runtime: {
        session: { model: { id: "fake" }, subscribe: () => () => {} },
        services: { modelRuntime: { completeSimple } },
      },
      initialMessage: "start",
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
    ["bootstrap"],
  ])
    await expect(launch([...args, ...f.args])).rejects.toThrow();
  mocks.bootstrap.mockResolvedValue({ validated: true });
  await launch(["bootstrap", "--repo", f.repository, ...f.args]);
  expect(mocks.bootstrap).toHaveBeenCalled();
  await launch(["status", ...f.args]);
});
it("launches committed worktree with explicit contract and provides human-only approval", async () => {
  const f = await setup();
  const config = join(f.root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      schema: "pi-dspy-gepa.launch.v1",
      acceptance: { criteria: ["Goal"], commands: ["true"] },
      constraints: ["Only local edits"],
      authority: f.campaign.authority,
    }),
  );
  mocks.run.mockImplementation(async () => {
    const options = mocks.open.mock.calls.at(-1)![0];
    const learnedId = options.store.addCandidate({
      ...seedCandidate(),
      instructions: "New default",
    });
    expect(await options.commands.approve(learnedId)).toContain("remains pinned");
    expect(await options.commands.learning()).toContain("trials");
  });
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
    "--rlm",
    "/tmp/rlm",
    ...f.args,
  ]);
  const db = new Store(f.state);
  try {
    const campaign = db.campaigns()[0]!;
    expect(campaign.authority.merge).toBe(false);
    expect(campaign.acceptance?.commands).toEqual(["true"]);
    expect(campaign.status).toBe("paused");
    expect(db.defaultCandidate(f.repository)).not.toBe(campaign.candidateId);
  } finally {
    db.close();
  }
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await launch(["status", ...f.args]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('"evidenceCurrent":false'));
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
it("starts bounded learning only on idle and reports model reflection and results", async () => {
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
    live.control.pause();
    await vi.waitFor(() => expect(mocks.experiment).toHaveBeenCalled());
  });
  await launch(["start", "--repo", f.repository, "--goal", "Goal", "--config", config, ...f.args]);
  expect(f.completeSimple).toHaveBeenCalledTimes(2);
  expect(await readFile(config, "utf8")).toContain("maxTrials");
});
