import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { independentEvaluator } from "../src/runtime/evaluator.js";
import { PythonWorker } from "../src/runtime/python.js";
import { openCampaign, type CampaignSession } from "../src/runtime/session.js";
import { herdrSessions, lastAssistant } from "../src/runtime/sessions.js";
import {
  assistant,
  fakeSessions,
  FakeWorker,
  fixture,
  model,
  plan,
  program,
  report,
  review,
} from "./helpers.js";
import { runtimeFixture } from "./runtime-fixture.js";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const sessions: CampaignSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const f of fixtures.splice(0)) await f.close();
});
const signal = () => AbortSignal.timeout(30000);
const outputs = {
  plan: { ...plan, commands: ['test "$(cat source.txt)" = finished'] },
  implement: report,
  review,
  fix: report,
};
/** The stage named by the fake program's opening prompt; undefined for the evaluator. */
const stageOf = (context: Context) =>
  /Stage (\w+) system/.exec(JSON.stringify(context.messages[0]))?.[1];
/** Scripted model: stage sessions answer from their opening prompt; the evaluator passes. */
function respond(context: Context) {
  if ((context.systemPrompt ?? "").startsWith("You are an independent"))
    return assistant(`Verdict:\n${JSON.stringify(review)}`);
  const stage = stageOf(context) as keyof typeof outputs;
  if (stage === "implement" && context.messages.at(-1)?.role === "user")
    return assistant("", [
      {
        type: "toolCall",
        id: "w1",
        name: "write",
        arguments: { path: "source.txt", content: "finished" },
      },
    ]);
  return assistant(JSON.stringify(outputs[stage]));
}

it("runs each stage in a fresh in-process Pi session with its own tools and transcript", async () => {
  const f = await fixture();
  fixtures.push(f);
  const { model: _model, ...services } = await runtimeFixture(f.root, respond);
  const live = await openCampaign({ ...f, ...services, worker: new FakeWorker([program]) });
  sessions.push(live);
  expect(live.model).toEqual(model);
  await live.run(signal());
  expect(f.campaign.status, f.campaign.result ?? "").toBe("completed");
  expect(await readFile(join(f.campaign.worktree, "source.txt"), "utf8")).toBe("finished");
  expect(await readFile(join(f.repository, "source.txt"), "utf8")).toBe("starting\n");
  const stages = services.requests.map((context) => stageOf(context) ?? "evaluator");
  expect(stages).toEqual(["plan", "implement", "implement", "evaluator", "review"]);
  expect(services.requests[0]!.tools?.map((tool) => tool.name)).toEqual([
    "read",
    "grep",
    "find",
    "ls",
  ]);
  expect(services.requests[1]!.tools?.map((tool) => tool.name)).toContain("write");
  expect(services.requests[3]!.tools ?? []).toHaveLength(0);
  expect(live.ledger.calls).toBe(5);
  const transcripts = await Promise.all(
    ["plan-1", "implement-2", "review-3"].map(async (label) => {
      const directory = join(f.store.root, "runs", f.campaign.id, "sessions", label);
      const [file] = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
      return readFile(join(directory, file!), "utf8");
    }),
  );
  expect(services.requests[0]!.systemPrompt).not.toContain("Stage plan system");
  expect(transcripts[0]).toContain("Stage plan system");
  expect(transcripts[0]).toContain(f.campaign.goal);
  expect(transcripts[0]).not.toContain('"name":"write"');
  expect(transcripts[1]).toContain('"name":"write"');
  expect(transcripts[2]).toContain("+finished");
  expect(transcripts[2]).not.toContain('"name":"write"');
});

it("fails the campaign explicitly on worker errors or a second unparseable reply", async () => {
  const f = await fixture();
  fixtures.push(f);
  const services = await runtimeFixture(f.root);
  const lost = await openCampaign({
    ...f,
    ...services,
    worker: new FakeWorker([new Error("Worker lost")]),
  });
  sessions.push(lost);
  await lost.run(signal());
  expect(f.campaign).toMatchObject({ status: "failed", result: "Error: Worker lost" });
  f.campaign.status = "active";
  const stage = fakeSessions({ plan: ["no json", "still no json"] });
  const repaired = await openCampaign({
    ...f,
    ...(await runtimeFixture(join(f.root, "second"))),
    worker: new FakeWorker([program]),
    sessions: stage,
  });
  sessions.push(repaired);
  await repaired.run(signal());
  expect(f.campaign.status).toBe("failed");
  expect(stage.requests.map((request) => request.fresh)).toEqual([true, false]);
  expect(services.requests).toHaveLength(0);
  await expect(openCampaign({ ...f, ...services, worker: new FakeWorker([]) })).rejects.toThrow(
    "already belongs to an open campaign",
  );
});

it("pause finishes the running stage and stops before the next; abort cancels", async () => {
  const f = await fixture();
  fixtures.push(f);
  const services = await runtimeFixture(f.root);
  let live: CampaignSession;
  const stage = fakeSessions({
    plan: [plan],
    implement: [
      () => {
        live.control.pause();
        return report;
      },
    ],
  });
  live = await openCampaign({
    ...f,
    ...services,
    worker: new FakeWorker([program]),
    sessions: stage,
  });
  sessions.push(live);
  await live.run(signal());
  expect(f.campaign).toMatchObject({ status: "paused", stage: "review" });
  expect(f.campaign.notes).toContain("implement: Did the stage work.");
  expect(stage.requests.map((request) => request.stage)).toEqual(["plan", "implement"]);
  await live.close();
  sessions.splice(sessions.indexOf(live), 1);
  expect(stage.closed).toBe(1);
  f.campaign.status = "active";
  const abort = new AbortController();
  const aborted = fakeSessions({
    review: [
      () => {
        abort.abort(new Error("User stopped"));
        return review;
      },
    ],
  });
  const resumed = await openCampaign({
    ...f,
    ...(await runtimeFixture(join(f.root, "second"))),
    resume: true,
    worker: new FakeWorker([program]),
    sessions: aborted,
  });
  sessions.push(resumed);
  await resumed.run(abort.signal);
  expect(f.campaign).toMatchObject({ status: "cancelled", result: "Error: User stopped" });
});

it("drives Herdr panes: split, start pi with the stage policy, prompt by file, read the transcript", async () => {
  const f = await fixture();
  fixtures.push(f);
  const services = await runtimeFixture(f.root);
  const herdr = join(f.root, "herdr");
  const statePath = join(f.root, "herdr-state.json");
  const repliesPath = join(f.root, "replies.json");
  await writeFile(
    herdr,
    `#!${process.execPath}
const fs = require("node:fs");
const state = fs.existsSync(${JSON.stringify(statePath)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")) : { calls: [], closed: [] };
const [group, action, ...rest] = process.argv.slice(2);
state.calls.push(process.argv.slice(2));
let out = { result: {} };
if (group === "pane" && action === "split") out = { result: { pane: { pane_id: "p9" } } };
else if (group === "pane" && action === "close") state.closed.push(rest[0]);
else if (group === "agent" && action === "start") {
  const args = rest.slice(rest.indexOf("--") + 1);
  state.dir = args[args.indexOf("--session-dir") + 1];
  state.entries = 0;
} else if (group === "agent" && action === "prompt") {
  const replies = JSON.parse(fs.readFileSync(${JSON.stringify(repliesPath)}, "utf8"));
  const reply = replies.shift();
  fs.writeFileSync(${JSON.stringify(repliesPath)}, JSON.stringify(replies));
  if (reply === null) { console.error("agent_blocked"); process.exit(1); }
  const prompt = fs.readFileSync(/Read (\\S+) completely/.exec(rest[1])[1], "utf8");
  // A real pi session file: header, then a parent-linked entry chain.
  const file = state.dir + "/session.jsonl";
  const line = (message) => JSON.stringify({
    type: "message", id: "e" + ++state.entries, parentId: state.entries > 1 ? "e" + (state.entries - 1) : null, timestamp: "", message,
  }) + "\\n";
  if (reply !== "") {
    if (!fs.existsSync(file))
      fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "fake", timestamp: "", cwd: process.cwd() }) + "\\n");
    fs.appendFileSync(file,
      line({ role: "user", content: prompt, timestamp: 0 }) +
      line({ role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop", timestamp: 0 }));
  }
}
fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
console.log("herdr log line");
console.log(JSON.stringify(out));
`,
  );
  await chmod(herdr, 0o755);
  await writeFile(
    repliesPath,
    JSON.stringify([JSON.stringify(plan), JSON.stringify({ ...report, blocker: "Stop here" })]),
  );
  const artifacts = f.store.runPath(f.campaign.id);
  const stage = herdrSessions(f.campaign.worktree, artifacts, "caller-pane", herdr);
  const live = await openCampaign({
    ...f,
    ...services,
    worker: new FakeWorker([program]),
    sessions: stage,
  });
  sessions.push(live);
  await live.run(signal());
  expect(f.campaign).toMatchObject({ status: "blocked", result: "Stop here" });
  const planDir = join(artifacts, "sessions", "plan-1");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  expect(state.calls[0]).toEqual([
    "pane",
    "split",
    "--pane",
    "caller-pane",
    "--direction",
    "right",
    "--cwd",
    f.campaign.worktree,
    "--no-focus",
  ]);
  expect(state.calls[1].slice(0, 9)).toEqual([
    "agent",
    "start",
    expect.stringMatching(/^plan-1-[0-9a-f]{4}$/),
    "--kind",
    "pi",
    "--pane",
    "p9",
    "--timeout",
    "120000",
  ]);
  expect(state.calls[1].slice(9)).toEqual([
    "--",
    "--session-dir",
    planDir,
    "--tools",
    "read,grep,find,ls",
  ]);
  expect(state.calls[2]).toEqual([
    "agent",
    "prompt",
    state.calls[1][2],
    expect.stringContaining(join(planDir, "prompt-1.md")),
    "--wait",
  ]);
  expect(state.calls[3]).toEqual(["pane", "close", "p9"]);
  expect(state.calls[5].at(-1)).toBe("read,grep,find,ls,bash,edit,write");
  const prompt = await readFile(join(planDir, "prompt-1.md"), "utf8");
  expect(prompt.startsWith("Stage plan system")).toBe(true);
  expect(prompt).toContain(f.campaign.goal);
  expect(await readFile(join(planDir, "session.jsonl"), "utf8")).toContain(plan.plan);
  await live.close();
  sessions.splice(sessions.indexOf(live), 1);
  expect(JSON.parse(await readFile(statePath, "utf8")).closed).toEqual(["p9", "p9"]);
  const request = { stage: "fix" as const, label: "fix-9", tools: [] as string[] };
  await expect(
    stage.prompt({ ...request, fresh: false, prompt: "continue" }, signal()),
  ).rejects.toThrow("No open stage session to continue");
  await writeFile(repliesPath, JSON.stringify([null, ""]));
  await expect(stage.prompt({ ...request, fresh: true, prompt: "p" }, signal())).rejects.toThrow(
    "herdr agent prompt failed: agent_blocked",
  );
  await expect(stage.prompt({ ...request, fresh: true, prompt: "p" }, signal())).rejects.toThrow(
    "Stage session produced no transcript",
  );
  await chmod(herdr, 0o644);
  await expect(stage.prompt({ ...request, fresh: true, prompt: "p" }, signal())).rejects.toThrow();
});

it("reads the final assistant message; errors and empty sessions fail", () => {
  const user = { role: "user" as const, content: "hi", timestamp: 0 };
  expect(lastAssistant([user, assistant("first"), assistant("  final  ")])).toEqual({
    text: "final",
  });
  expect(() => lastAssistant([user])).toThrow("without an assistant message");
  expect(() =>
    lastAssistant([{ ...assistant("x"), stopReason: "error", errorMessage: "Provider down" }]),
  ).toThrow("Provider down");
  expect(() => lastAssistant([{ ...assistant("x"), stopReason: "aborted" }])).toThrow(
    "Stage session aborted",
  );
});

it("independent evaluator makes one tool-free call with complete check output", async () => {
  const f = await fixture();
  fixtures.push(f);
  let failing = false;
  const services = await runtimeFixture(f.root, (context) => {
    expect(context.tools ?? []).toHaveLength(0);
    expect(JSON.stringify(context.messages)).toContain("complete check output");
    const response = assistant(`Verdict follows.\n${JSON.stringify(review)}\nDone.`);
    if (failing) response.stopReason = "error";
    return response;
  });
  const outputPath = join(f.root, "check.log");
  await writeFile(outputPath, "complete check output");
  const evaluate = independentEvaluator(services.modelRuntime, model);
  const input = {
    goal: "Goal",
    plan: "Plan",
    constraints: [],
    criteria: ["Done"],
    diff: "+finished",
    checks: [{ command: "true", exitCode: 0, outputPath }],
  };
  expect(await evaluate(input, signal())).toEqual(review);
  failing = true;
  await expect(evaluate(input, signal())).rejects.toThrow("Independent review failed");
});

it("keeps a persistent real Python worker and reports unknown operations and unavailability", async () => {
  const f = await fixture();
  fixtures.push(f);
  const worker = new PythonWorker(join(f.root, "python.log"));
  try {
    await expect(
      worker.request({ operation: "invalid" }, async () => ({}), AbortSignal.timeout(15000)),
    ).rejects.toThrow("Unknown");
    await expect(
      worker.request({ operation: "invalid" }, async () => ({}), AbortSignal.timeout(15000)),
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
