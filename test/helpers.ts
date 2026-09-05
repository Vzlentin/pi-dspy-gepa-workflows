import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type Api,
  type Model,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { CampaignControl } from "../src/campaign/control.js";
import { git } from "../src/campaign/process.js";
import { startCampaign } from "../src/campaign/workspace.js";
import { zeroUsage } from "../src/runtime/accounting.js";
import { seedCandidate } from "../src/runtime/policy.js";
import type { Worker, Exchange } from "../src/runtime/python.js";
import type { StagePrompt, StageSessions } from "../src/runtime/sessions.js";
import type { Review, Stage } from "../src/state/contracts.js";
import { Store } from "../src/state/store.js";

export const review: Review = {
  schema: "pi-dspy-gepa.review.v1",
  completeness: true,
  correctness: true,
  maintainability: true,
  findings: "All criteria met without unnecessary complexity.",
};
export const acceptance = { criteria: ["Source is finished"], commands: ["true"] };
export const plan = { plan: "Change source and verify it.", ...acceptance, blocker: "" };
export const report = { summary: "Did the stage work.", notes: [], blocker: "" };
export const model: Model<Api> = {
  id: "fake",
  name: "fake",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};
export function assistant(
  text: string,
  content: AssistantMessage["content"] = [{ type: "text", text }],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}
export function fakeStream(response: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "done",
    reason: response.stopReason as "stop" | "toolUse",
    message: response,
  });
  stream.end(response);
  return stream;
}
type Script = (payload: unknown, exchange: Exchange, signal: AbortSignal) => Promise<unknown>;
export class FakeWorker implements Worker {
  calls: unknown[] = [];
  closed = false;
  constructor(readonly scripts: (Script | Error)[]) {}
  async request(payload: unknown, exchange: Exchange, signal: AbortSignal): Promise<unknown> {
    this.calls.push(payload);
    signal.throwIfAborted();
    const script = this.scripts.shift();
    if (!script) throw new Error("Fake worker script exhausted");
    if (script instanceof Error) throw script;
    return script(payload, exchange, signal);
  }
  async close() {
    this.closed = true;
  }
}
type State = { status: string; stage: Stage };
/** The DSPy workflow's host protocol without Python: same order, sessions, one repair turn. */
export const program: Script = async (_payload, exchange, signal) => {
  let state = (await exchange("status", {}, signal)) as State;
  while (state.status === "active") {
    const stage = state.stage;
    const inputs = (await exchange("inputs", {}, signal)) as State & Record<string, string>;
    if (inputs.status !== "active") return inputs;
    const session = (fresh: boolean, prompt: string) =>
      exchange("session", { fresh, prompt }, signal) as Promise<{ text: string }>;
    let text = (
      await session(true, `Stage ${stage} system\n\n${inputs.brief}\n\n${inputs.evidence ?? ""}`)
    ).text;
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      text = (await session(false, "Reply with only the JSON object.")).text;
      output = JSON.parse(text);
    }
    const { status: _status, stage: _stage, ...input } = inputs;
    state = (await exchange("record", { input, output, trace: [] }, signal)) as State;
  }
  return state;
};
type Reply = string | object | ((request: StagePrompt) => unknown);
/** Stage sessions answered from a per-stage script; non-string replies are sent as JSON. */
export function fakeSessions(replies: Partial<Record<Stage, Reply[]>>) {
  const requests: StagePrompt[] = [];
  const sessions: StageSessions & { requests: StagePrompt[]; closed: number } = {
    requests,
    closed: 0,
    async prompt(request, signal) {
      signal.throwIfAborted();
      requests.push(request);
      const queue = replies[request.stage] ?? [];
      if (!queue.length) throw new Error(`Fake session script exhausted for ${request.stage}`);
      let reply = queue.shift();
      if (typeof reply === "function") reply = await reply(request);
      return { text: typeof reply === "string" ? reply : JSON.stringify(reply) };
    },
    async close() {
      sessions.closed++;
    },
  };
  return sessions;
}
export async function fixture(candidate = seedCandidate()) {
  const root = await mkdtemp(join(tmpdir(), "campaign-test-"));
  const repository = join(root, "repo");
  await mkdir(repository);
  await git(repository, "init", "-q");
  await git(repository, "config", "user.name", "Test");
  await git(repository, "config", "user.email", "test@localhost");
  await writeFile(join(repository, "source.txt"), "starting\n");
  await writeFile(join(repository, ".gitignore"), "node_modules/\n");
  await git(repository, "add", ".");
  await git(repository, "-c", "commit.gpgsign=false", "commit", "-qm", "test: initial source");
  const store = new Store(join(root, "state", "state.sqlite"));
  const candidateId = store.addCandidate(candidate);
  const campaign = await startCampaign(store, {
    repository,
    goal: "Change source to finished",
    candidateId,
  });
  const control = new CampaignControl(store, campaign, async () => review, join(root, "artifacts"));
  return {
    root,
    repository,
    store,
    campaign,
    candidate,
    control,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
