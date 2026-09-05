import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ownerAlive, ownerToken } from "../src/campaign/workspace.js";
import { installDispatcher, modelContext, addUsage, zeroUsage } from "../src/runtime/dispatcher.js";
import { PythonWorker, PACKAGE_ROOT } from "../src/runtime/python.js";
import { openCampaign, type CampaignSession } from "../src/runtime/session.js";
import { fixture, FakeWorker, call, model, fakeStream, assistant, review } from "./helpers.js";
import { runtimeFixture } from "./runtime-fixture.js";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const sessions: CampaignSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const f of fixtures.splice(0)) await f.close();
});
async function setup(actions: ConstructorParameters<typeof FakeWorker>[0]) {
  const f = await fixture();
  fixtures.push(f);
  const services = await runtimeFixture(f.root);
  const worker = new FakeWorker(actions);
  const live = await openCampaign({ ...f, ...services, worker, reviewer: async () => review });
  sessions.push(live);
  return { ...f, ...services, worker, live };
}
it("runs multiple work items through real Pi tools and continues after ordinary responses and RLM final", async () => {
  const f = await setup([
    call("campaign", {
      action: "acceptance",
      acceptance: {
        criteria: ["Source is finished"],
        commands: ['test "$(cat source.txt)" = finished'],
      },
    }),
    call("write", { path: "source.txt", content: "finished" }),
    { text: "First item done", toolCalls: [] },
    call("ipython", { code: "await rlm.final('item two')" }),
    call("campaign", { action: "complete" }),
  ]);
  await f.live.runHeadless(AbortSignal.timeout(10000));
  expect(f.campaign.status).toBe("completed");
  expect(f.worker.calls).toHaveLength(5);
  expect(await readFile(join(f.repository, "source.txt"), "utf8")).toBe("starting\n");
  expect(await readFile(f.campaign.sessionPath!, "utf8")).toContain("First item done");
});
it("routes summaries to original Pi stream and persists goal/notes after compaction", async () => {
  const f = await setup([
    call("campaign", { action: "notes", text: "Remember sentinel" }),
    { text: "ready", toolCalls: [] },
  ]);
  await f.live.runtime.session.bindExtensions({});
  await f.live.runtime.session.prompt("Work item " + "context ".repeat(100));
  f.live.control.pause();
  await f.live.runtime.session.compact("Keep facts");
  expect(f.requests.some((context) => !context.tools?.length)).toBe(true);
  expect(f.live.control.brief()).toContain("Remember sentinel");
  expect(f.live.control.brief()).toContain(f.campaign.goal);
  expect(await readFile(f.campaign.sessionPath!, "utf8")).toContain("Work item");
  expect(f.worker.calls).toHaveLength(2);
  await f.live.runtime.session.reload();
  f.live.control.continue();
  f.worker.actions.push(call("campaign", { action: "blocker", text: "Need next requirement" }));
  await f.live.runtime.session.prompt("Reloaded");
  expect(f.campaign.status).toBe("blocked");
});
it.each(["unknown", "bad-arguments", "duplicate", "malformed", "worker-failed"])(
  "fails explicitly on %s DSPy output without ordinary reasoning fallback",
  async (kind) => {
    const action =
      kind === "worker-failed"
        ? new Error("Worker lost")
        : kind === "unknown"
          ? call("not-a-tool", {})
          : kind === "bad-arguments"
            ? call("write", { wrong: true })
            : kind === "duplicate"
              ? {
                  text: "",
                  toolCalls: [
                    ...call("read", { path: "source.txt" }).toolCalls,
                    ...call("read", { path: "source.txt" }).toolCalls,
                  ],
                }
              : async () => ({ action: { approve: true } });
    const f = await setup([action]);
    await f.live.runHeadless(AbortSignal.timeout(10000));
    expect(f.campaign.status).toBe("failed");
    expect(f.requests).toHaveLength(0);
  },
);
it("rejects image input explicitly", async () => {
  const f = await setup([]);
  await f.live.runtime.session.bindExtensions({});
  await f.live.runtime.session.prompt("image", {
    images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
  });
  expect(f.campaign.status).toBe("failed");
  expect(f.worker.calls).toHaveLength(0);
});
it("refuses startup without RLM or with incompatible program provenance", async () => {
  const f = await fixture();
  fixtures.push(f);
  const services = await runtimeFixture(f.root);
  const worker = new FakeWorker([]);
  const { rlmPackage: _rlm, ...withoutRlm } = services;
  await expect(openCampaign({ ...f, ...withoutRlm, worker })).rejects.toThrow(
    "pi-ipython-rlm is required",
  );
  expect(worker.closed).toBe(true);
  await expect(
    openCampaign({
      ...f,
      ...services,
      candidate: {
        ...f.candidate,
        provenance: { ...f.candidate.provenance, programDigest: "bad" },
      },
      worker: new FakeWorker([]),
    }),
  ).rejects.toThrow("identity");
});
it("pause settles the active action, blocks subsequent actions, and abort cancels execution", async () => {
  let settle: (() => void) | undefined;
  const f = await setup([
    async () => {
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      return { action: call("write", { path: "source.txt", content: "should not run" }) };
    },
  ]);
  await f.live.runtime.session.bindExtensions({});
  const running = f.live.runtime.session.prompt("start");
  await vi.waitFor(() => expect(settle).toBeDefined());
  f.live.control.pause();
  settle!();
  await running;
  expect(await readFile(join(f.campaign.worktree, "source.txt"), "utf8")).toBe("starting\n");
  expect(f.worker.calls).toHaveLength(1);
  f.live.control.continue();
  f.worker.actions.push(async (_payload, _exchange, signal) => {
    await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  const aborting = f.live.runtime.session.prompt("again");
  await vi.waitFor(() => expect(f.worker.calls).toHaveLength(2));
  await f.live.runtime.session.abort();
  await aborting;
  expect(f.campaign.status).toBe("failed");
});
it("requires acceptance before coding actions and never replays on explicit resume", async () => {
  const f = await setup([
    call("write", { path: "source.txt", content: "forbidden" }),
    call("campaign", { action: "blocker", text: "Need acceptance" }),
  ]);
  await f.live.runHeadless(AbortSignal.timeout(10000));
  expect(await readFile(join(f.campaign.worktree, "source.txt"), "utf8")).toBe("starting\n");
  const previousFile = f.campaign.sessionPath;
  await f.live.close();
  sessions.splice(sessions.indexOf(f.live), 1);
  f.campaign.status = "active";
  f.store.saveCampaign(f.campaign);
  const worker = new FakeWorker([
    call("campaign", { action: "blocker", text: "Inspected current artifacts" }),
  ]);
  const resumed = await openCampaign({ ...f, worker, resume: true, reviewer: async () => review });
  sessions.push(resumed);
  expect(resumed.initialMessage).toContain("Python variables were lost");
  await resumed.runHeadless(AbortSignal.timeout(10000));
  expect(f.campaign.sessionPath).toBe(previousFile);
  expect(worker.calls).toHaveLength(1);
  expect(JSON.stringify(worker.calls)).toContain("Need acceptance");
});
it("uses the Python model bridge and validates roles, usage, and unsupported worker requests", async () => {
  const f = await setup([
    async (_payload, exchange, signal) => {
      const result = await exchange(
        "model",
        {
          messages: [
            { role: "system", content: "DSPy prompt" },
            { role: "user", content: "task" },
            { role: "assistant", content: "demo" },
          ],
        },
        signal,
      );
      expect(result).toMatchObject({ text: "fake summary" });
      return { action: call("campaign", { action: "blocker", text: "bridge used" }) };
    },
  ]);
  await f.live.runHeadless(AbortSignal.timeout(10000));
  expect(f.requests).toHaveLength(1);
  expect(() => modelContext({ messages: [{ role: "tool", content: "unsupported" }] })).toThrow(
    "Unsupported",
  );
  const usage = zeroUsage();
  const other = zeroUsage();
  other.input = 10;
  other.cost.total = 2;
  addUsage(usage, other);
  expect(usage.input).toBe(10);
  expect(usage.cost.total).toBe(2);
  const session = f.live.runtime.session;
  session.agent.streamFunction = fakeStream(assistant("fallback"));
  const original = installDispatcher(
    session,
    f.live.control,
    f.candidate,
    new FakeWorker([]),
    join(f.root, "unused"),
  );
  expect((await (await original(model, { messages: [] })).result()).content).toEqual([
    { type: "text", text: "fallback" },
  ]);
});
it("runs a persistent real Python DSPy worker over Pi model responses and closes without replay", async () => {
  const f = await fixture();
  fixtures.push(f);
  const worker = new PythonWorker(join(f.root, "python.log"));
  try {
    const payload = {
      operation: "decide",
      candidate: f.candidate,
      input: { inheritedInstructions: "rules", brief: "task", context: "[]", tools: "[]" },
    };
    const exchange = async () => ({ text: '{"action":{"text":"chosen","toolCalls":[]}}' });
    for (let i = 0; i < 2; i++)
      expect(await worker.request(payload, exchange, AbortSignal.timeout(15000))).toMatchObject({
        action: { text: "chosen", toolCalls: [] },
      });
    await expect(
      worker.request({ operation: "invalid" }, exchange, AbortSignal.timeout(5000)),
    ).rejects.toThrow("Unknown");
  } finally {
    await worker.close();
  }
  await expect(worker.request({}, async () => ({}), new AbortController().signal)).rejects.toThrow(
    "unavailable",
  );
});
it("terminates stuck Python processes on cancellation and rejects malformed protocol", async () => {
  const f = await fixture();
  fixtures.push(f);
  const script = join(f.root, "worker.cjs");
  await writeFile(script, "process.stdin.on('data', () => {}); setInterval(() => {}, 1000)");
  const worker = new PythonWorker(join(f.root, "stderr"), process.execPath, [script]);
  const pending = worker.request({}, async () => ({}), AbortSignal.timeout(100));
  await expect(worker.request({}, async () => ({}), new AbortController().signal)).rejects.toThrow(
    "one campaign decision",
  );
  await expect(pending).rejects.toThrow("aborted");
  await worker.close();
  await writeFile(script, "process.stdin.on('data',()=>console.log('invalid json'))");
  const malformed = new PythonWorker(join(f.root, "stderr2"), process.execPath, [script]);
  await expect(
    malformed.request({}, async () => ({}), AbortSignal.timeout(3000)),
  ).rejects.toThrow();
  await malformed.close();
});
it("recovers a killed real Pi process without replaying its last completed tool", async () => {
  const f = await fixture();
  fixtures.push(f);
  f.campaign.acceptance = { criteria: ["One append"], commands: ["true"] };
  f.store.saveCampaign(f.campaign);
  const marker = join(f.root, "ready");
  const script = join(f.root, "child.mts");
  await writeFile(
    script,
    `
import { writeFile } from 'node:fs/promises';
import { Store } from ${JSON.stringify(join(PACKAGE_ROOT, "src/state/store.ts"))};
import { openCampaign } from ${JSON.stringify(join(PACKAGE_ROOT, "src/runtime/session.ts"))};
import { ownerAlive, ownerToken } from ${JSON.stringify(join(PACKAGE_ROOT, "src/campaign/workspace.ts"))};
import { FakeWorker, call, review } from ${JSON.stringify(join(PACKAGE_ROOT, "test/helpers.ts"))};
import { runtimeFixture } from ${JSON.stringify(join(PACKAGE_ROOT, "test/runtime-fixture.ts"))};
const store = new Store(${JSON.stringify(f.store.filePath)});
const campaign = store.getCampaign(${JSON.stringify(f.campaign.id)});
store.claim(campaign.worktree, ownerToken(), ownerAlive);
const options = await runtimeFixture(${JSON.stringify(join(f.root, "child-runtime"))});
const worker = new FakeWorker([call('bash', { command: 'printf x >> counter.txt' }), async () => { await writeFile(${JSON.stringify(marker)}, 'ready'); await new Promise(() => {}); }]);
const live = await openCampaign({store,campaign,candidate:store.candidate(campaign.candidateId),...options,worker,reviewer:async()=>review});
setInterval(()=>{},1000);
await live.runHeadless(new AbortController().signal);
`,
  );
  const child = spawn(
    process.execPath,
    ["--import", join(PACKAGE_ROOT, "node_modules/tsx/dist/loader.mjs"), script],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  const exited = once(child, "exit");
  try {
    await vi.waitFor(
      async () => {
        expect(child.exitCode, errors).toBeNull();
        expect(await readFile(marker, "utf8")).toBe("ready");
      },
      { timeout: 15000 },
    );
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  const campaign = f.store.getCampaign(f.campaign.id)!;
  expect(campaign.sessionPath).not.toBeNull();
  const token = ownerToken();
  f.store.claim(campaign.worktree, token, ownerAlive);
  const options = await runtimeFixture(join(f.root, "resumed-runtime"));
  const worker = new FakeWorker([
    call("campaign", { action: "blocker", text: "Inspected surviving artifacts" }),
  ]);
  const live = await openCampaign({
    ...f,
    ...options,
    campaign,
    worker,
    resume: true,
    reviewer: async () => review,
  });
  sessions.push(live);
  await live.runHeadless(AbortSignal.timeout(10000));
  expect(await readFile(join(campaign.worktree, "counter.txt"), "utf8")).toBe("x");
  expect(worker.calls).toHaveLength(1);
  expect(JSON.stringify(worker.calls)).toContain("Python variables were lost");
  f.store.release(campaign.worktree, token);
});
