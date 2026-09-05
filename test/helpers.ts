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
import { seedCandidate, zeroUsage, type Stream } from "../src/runtime/dispatcher.js";
import type { Worker, Exchange } from "../src/runtime/python.js";
import type { Action, Review } from "../src/state/contracts.js";
import { Store } from "../src/state/store.js";

export const review: Review = {
  schema: "pi-dspy-gepa.review.v1",
  completeness: true,
  correctness: true,
  maintainability: true,
  findings: "All criteria met without unnecessary complexity.",
};
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
export function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
export function fakeStream(response: AssistantMessage = assistant("fake summary")): Stream {
  return () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: response });
    stream.end(response);
    return stream;
  };
}
export class FakeWorker implements Worker {
  calls: unknown[] = [];
  closed = false;
  constructor(
    readonly actions: (
      | Action
      | Error
      | ((payload: unknown, exchange: Exchange, signal: AbortSignal) => Promise<unknown>)
    )[],
  ) {}
  async request(payload: unknown, exchange: Exchange, signal: AbortSignal): Promise<unknown> {
    this.calls.push(payload);
    signal.throwIfAborted();
    const action = this.actions.shift();
    if (!action) throw new Error("Fake DSPy script exhausted");
    if (action instanceof Error) throw action;
    if (typeof action === "function") return action(payload, exchange, signal);
    return { action, trace: [] };
  }
  async close() {
    this.closed = true;
  }
}
export function call(name: string, args: Record<string, unknown>, id = "call"): Action {
  return { text: "", toolCalls: [{ id, name, arguments: args }] };
}
export async function fixture() {
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
  const candidate = seedCandidate();
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
