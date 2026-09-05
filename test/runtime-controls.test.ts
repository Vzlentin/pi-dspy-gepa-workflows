import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { accountModels, UsageLedger } from "../src/runtime/accounting.js";
import { PythonWorker } from "../src/runtime/python.js";
import { loadRlm } from "../src/runtime/rlm.js";
import { openCampaign, type CampaignSession } from "../src/runtime/session.js";
import { fixture, FakeWorker, call, review, model, assistant, fakeStream } from "./helpers.js";
import { runtimeFixture } from "./runtime-fixture.js";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const sessions: CampaignSession[] = [];
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  return { ...f, ...(await runtimeFixture(f.root)) };
}
afterEach(async () => {
  for (const live of sessions.splice(0)) await live.close();
  for (const f of fixtures.splice(0)) await f.close();
});
it("runs human commands, keeping approval absent from the agent tool", async () => {
  const f = await setup();
  const approve = vi.fn(async () => "approved for future campaigns");
  const learning = vi.fn(async () => "candidate comparisons");
  const live = await openCampaign({
    ...f,
    worker: new FakeWorker([call("campaign", { action: "blocker", text: "pause again" })]),
    commands: { approve, learning },
  });
  sessions.push(live);
  await live.runtime.session.bindExtensions({});
  const extension = live.runtime.services.resourceLoader
    .getExtensions()
    .extensions.find((value) => value.commands.has("campaign"))!;
  const handler = extension.commands.get("campaign")!.handler;
  const notify = vi.fn();
  const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;
  await handler("", ctx);
  await handler("status", ctx);
  await handler("pause", ctx);
  expect(f.campaign.status).toBe("paused");
  await handler("continue", ctx);
  await vi.waitFor(() => expect(f.campaign.status).toBe("blocked"));
  await handler("learning", ctx);
  expect(learning).toHaveBeenCalled();
  await handler("approve candidate", ctx);
  expect(approve).toHaveBeenCalledWith("candidate");
  await expect(handler("approve", ctx)).rejects.toThrow("Supply");
  await expect(handler("unknown", ctx)).rejects.toThrow("Unknown");
  expect(JSON.stringify(extension.tools.get("campaign")!.definition.parameters)).not.toContain(
    '"approve"',
  );
  await handler("abort", ctx);
  expect(f.campaign.status).toBe("cancelled");
  expect(notify).toHaveBeenCalled();
});
it("default command capabilities cannot promote from a headless runtime", async () => {
  const f = await setup();
  const live = await openCampaign({ ...f, worker: new FakeWorker([]) });
  sessions.push(live);
  const handler = live.runtime.services.resourceLoader
    .getExtensions()
    .extensions.find((value) => value.commands.has("campaign"))!
    .commands.get("campaign")!.handler;
  const notify = vi.fn();
  const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;
  await handler("learning", ctx);
  expect(notify).toHaveBeenCalledWith("No learning allowance configured.", "info");
  await expect(handler("approve candidate", ctx)).rejects.toThrow("human launcher");
});
it.each(["pass", "review-stream-error", "malformed"])(
  "performs an independent read-only %s review with full evidence",
  async (kind) => {
    const f = await setup();
    const seen: unknown[] = [];
    f.modelRuntime.registerProvider("test", {
      api: model.api,
      baseUrl: model.baseUrl,
      apiKey: "fake",
      models: [model],
      streamSimple(active, context) {
        seen.push(context);
        const response = assistant(kind === "malformed" ? "not-json" : JSON.stringify(review));
        if (kind === "review-stream-error") response.stopReason = "error";
        return fakeStream(response)(active, context) as ReturnType<
          typeof import("@earendil-works/pi-ai").createAssistantMessageEventStream
        >;
      },
    });
    f.campaign.acceptance = { criteria: ["No missing work"], commands: ["printf retained-output"] };
    f.store.saveCampaign(f.campaign);
    const live = await openCampaign({
      ...f,
      worker: new FakeWorker([
        call("campaign", { action: "plan", text: "Review the whole change." }),
        call("campaign", { action: "review" }),
        call("campaign", { action: "blocker", text: "Review unavailable" }),
      ]),
    });
    sessions.push(live);
    await live.runHeadless(AbortSignal.timeout(10000));
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).toContain("retained-output");
    expect(f.campaign.status).toBe(kind === "pass" ? "completed" : "blocked");
    expect(live.ledger.calls).toBe(1);
  },
);
it("meters model calls before dispatch, records in-flight usage, and cancels at the provider seam", async () => {
  const f = await setup();
  const ledger = new UsageLedger();
  const admission = vi.fn();
  const abort = new AbortController();
  const restore = accountModels(
    f.modelRuntime,
    admission,
    (value) => ledger.record(value),
    abort.signal,
  );
  try {
    await f.modelRuntime.completeSimple(model, { messages: [] });
    expect(admission).toHaveBeenCalledTimes(1);
    expect(ledger.calls).toBe(1);
    abort.abort();
    const result = await f.modelRuntime.completeSimple(model, { messages: [] });
    expect(result.stopReason).toBe("error");
    expect(admission).toHaveBeenCalledTimes(1);
  } finally {
    restore();
  }
  const blocked = accountModels(
    f.modelRuntime,
    () => {
      throw new Error("Allowance exhausted");
    },
    () => {},
  );
  try {
    expect((await f.modelRuntime.complete(model, { messages: [] })).errorMessage).toContain(
      "Allowance exhausted",
    );
  } finally {
    blocked();
  }
});
it("rejects shared model runtime ownership and restores it without stale cleanup", async () => {
  const f = await setup();
  const original = f.modelRuntime.streamSimple;
  const ledger = new UsageLedger();
  const admit = vi.fn();
  const abort = new AbortController();
  const restore = accountModels(
    f.modelRuntime,
    admit,
    (usage) => ledger.record(usage),
    abort.signal,
  );
  try {
    expect(() => accountModels(f.modelRuntime, admit, () => {})).toThrow("already belongs");
    await f.modelRuntime.completeSimple(model, { messages: [] });
    expect(admit).toHaveBeenCalledOnce();
    expect(ledger.calls).toBe(1);
    abort.abort();
  } finally {
    restore();
  }
  expect(f.modelRuntime.streamSimple).toBe(original);
  const next = accountModels(f.modelRuntime, admit, () => {});
  try {
    restore(); // An old session's repeated close must not unhook the new owner.
    expect(() => accountModels(f.modelRuntime, admit, () => {})).toThrow("already belongs");
    expect((await f.modelRuntime.completeSimple(model, { messages: [] })).stopReason).toBe("stop");
  } finally {
    next();
  }
  expect(f.modelRuntime.streamSimple).toBe(original);
});
it("waits for host exchange cleanup when a Python worker is cancelled", async () => {
  const f = await setup();
  const file = join(f.root, "pending.cjs");
  await writeFile(
    file,
    `process.stdin.on('data',()=>console.log(JSON.stringify({schema:'pi-dspy-gepa.python-request.v1',kind:'evaluate',payload:{}})))`,
  );
  const worker = new PythonWorker(join(f.root, "pending.log"), process.execPath, [file]);
  let entered = false;
  let cleaned = false;
  const request = worker.request(
    {},
    async (_kind, _payload, signal) => {
      entered = true;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            setTimeout(() => {
              cleaned = true;
              resolve();
            }, 20);
          },
          { once: true },
        ),
      );
      return {};
    },
    new AbortController().signal,
  );
  const rejected = expect(request).rejects.toThrow("closed");
  await vi.waitFor(() => expect(entered).toBe(true));
  await worker.close();
  await rejected;
  expect(cleaned).toBe(true);
});
it("validates RLM installation errors and resolves configured packages without installing anything", async () => {
  const f = await setup();
  await writeFile(
    join(f.rlmPackage, "package.json"),
    JSON.stringify({ name: "pi-ipython-rlm", pi: { extensions: ["./extensions/rlm.ts"] } }),
  );
  f.settingsManager.setPackages([f.rlmPackage]);
  expect(
    (await loadRlm(f.campaign.worktree, f.agentDir, undefined, f.settingsManager)).path,
  ).toContain("rlm.ts");
  await writeFile(join(f.rlmPackage, "extensions", "rlm.ts"), "export default 42");
  await expect(loadRlm(f.campaign.worktree, f.agentDir, f.rlmPackage)).rejects.toThrow(
    "no extension factory",
  );
  await writeFile(join(f.rlmPackage, "extensions", "rlm.ts"), "export default function() {}");
  await expect(openCampaign({ ...f, worker: new FakeWorker([]) })).rejects.toThrow(
    "did not register",
  );
  await writeFile(
    join(f.rlmPackage, "extensions", "rlm.ts"),
    "export default function() { throw new Error('broken installation'); }",
  );
  await expect(openCampaign({ ...f, worker: new FakeWorker([]) })).rejects.toThrow(
    "broken installation",
  );
});
it("returns explicit host exchange errors to Python and handles worker exit and invalid envelopes", async () => {
  const f = await setup();
  const script = join(f.root, "ipc.cjs");
  await writeFile(
    script,
    `let requested=false; process.stdin.on('data', line => { if (!requested) { requested=true; console.log(JSON.stringify({schema:'pi-dspy-gepa.python-request.v1',kind:'model',payload:{}})); } else { console.log(JSON.stringify({schema:'pi-dspy-gepa.python-response.v1',result:JSON.parse(line)})); } });`,
  );
  const worker = new PythonWorker(join(f.root, "worker.log"), process.execPath, [script]);
  try {
    expect(
      await worker.request(
        {},
        async () => {
          throw new Error("Host model unavailable");
        },
        AbortSignal.timeout(5000),
      ),
    ).toEqual({ error: "Error: Host model unavailable" });
  } finally {
    await worker.close();
  }
  for (const output of ["process.exit(1)", "console.log(JSON.stringify({schema:'wrong'}))"]) {
    await writeFile(script, `process.stdin.on('data',()=>{${output}})`);
    const broken = new PythonWorker(join(f.root, "broken.log"), process.execPath, [script]);
    try {
      await expect(
        broken.request({}, async () => ({}), AbortSignal.timeout(5000)),
      ).rejects.toThrow();
    } finally {
      await broken.close();
    }
  }
});
it("retains notes in the complete transcript after an accurate reload reset notice", async () => {
  const f = await setup();
  const live = await openCampaign({
    ...f,
    worker: new FakeWorker([call("campaign", { action: "blocker", text: "Waiting" })]),
  });
  sessions.push(live);
  await live.runHeadless(AbortSignal.timeout(10000));
  await live.runtime.session.reload();
  expect(await readFile(f.campaign.sessionPath!, "utf8")).toContain("Python variables were lost");
});
it("refuses to silently replace a missing or empty campaign transcript on resume", async () => {
  const f = await setup();
  const live = await openCampaign({
    ...f,
    worker: new FakeWorker([call("campaign", { action: "blocker", text: "Waiting" })]),
  });
  await live.runHeadless(AbortSignal.timeout(10000));
  await live.close();
  const path = f.campaign.sessionPath!;
  const saved = await readFile(path);
  await rm(path);
  await expect(openCampaign({ ...f, resume: true, worker: new FakeWorker([]) })).rejects.toThrow(
    "transcript is missing",
  );
  await writeFile(path, "");
  await expect(openCampaign({ ...f, resume: true, worker: new FakeWorker([]) })).rejects.toThrow(
    "transcript is missing",
  );
  await writeFile(path, saved);
});
