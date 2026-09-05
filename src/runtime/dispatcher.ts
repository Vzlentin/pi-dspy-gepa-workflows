import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import {
  createAssistantMessageEventStream,
  validateToolCall,
  type AssistantMessage,
  type Context,
  type Usage,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CampaignControl } from "../campaign/control.js";
import {
  ActionSchema,
  CandidateSchema,
  PROGRAM_ID,
  digest,
  validate,
  type Candidate,
} from "../state/contracts.js";
import { PACKAGE_ROOT, type Worker } from "./python.js";

export type Stream = AgentSession["agent"]["streamFunction"];
export function fixedProgramDigest(): string {
  return digest(
    ["program.py", "worker.py"].map((name) =>
      readFileSync(`${PACKAGE_ROOT}/python/pi_dspy_gepa/${name}`, "utf8"),
    ),
  );
}
export function seedCandidate(): Candidate {
  return {
    schema: "pi-dspy-gepa.candidate.v1",
    programId: PROGRAM_ID,
    repository: null,
    instructions:
      "Choose the next useful coding action toward the campaign goal. Honor inherited instructions and the fixed campaign contract. Read repository instructions, record complete acceptance criteria and checks before editing, then implement and verify. Save useful notes. Request completion through the campaign tool only when all work is ready. Report concrete blockers instead of inventing evidence.",
    demonstrations: [],
    provenance: { dspy: "3.3.1", gepa: "0.1.4", pi: "0.84.4", programDigest: fixedProgramDigest() },
  };
}
export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
export function addUsage(total: Usage, usage: Usage): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
    total[key] += usage[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
    total.cost[key] += usage.cost[key];
}
export function assertText(context: Context): void {
  for (const message of context.messages) {
    if (
      typeof message.content !== "string" &&
      message.content.some((part) => part.type === "image")
    )
      throw new Error("Campaigns currently support text inputs only; image input is unsupported");
  }
}
export function modelContext(payload: unknown): Context {
  const request = payload as { messages: { role: string; content: string }[] };
  return {
    systemPrompt: request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n"),
    messages: request.messages
      .filter((message) => message.role !== "system")
      .map((message) => {
        if (message.role === "user")
          return { role: "user" as const, content: message.content, timestamp: Date.now() };
        if (message.role === "assistant")
          return {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: message.content }],
            api: "openai-completions" as const,
            provider: "dspy",
            model: "history",
            usage: zeroUsage(),
            stopReason: "stop" as const,
            timestamp: Date.now(),
          };
        throw new Error(`Unsupported DSPy message role: ${message.role}`);
      }),
  };
}
export function installDispatcher(
  session: AgentSession,
  control: CampaignControl,
  candidate: Candidate,
  worker: Worker,
  tracePath: string,
  beforeModelCall: () => void = () => {},
): Stream {
  validate(CandidateSchema, candidate);
  if (candidate.provenance.programDigest !== fixedProgramDigest())
    throw new Error("Candidate fixed-program identity does not match this runtime");
  const original = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => {
    // Pi's pinned SDK builds compaction and branch-summary contexts with no tools.
    // Root campaigns always retain the campaign tool. RLM children never use this dispatcher.
    if (!context.tools?.some((tool) => tool.name === "campaign"))
      return original(model, context, options);
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const signal = options?.signal ?? new AbortController().signal;
    void (async () => {
      try {
        assertText(context);
        if (control.campaign.status !== "active")
          throw new Error(`Campaign is ${control.campaign.status}`);
        const input = {
          inheritedInstructions: `${context.systemPrompt ?? ""}\n${CONTROL_RULES}`,
          brief: control.brief(),
          context: JSON.stringify(context.messages),
          tools: JSON.stringify(context.tools),
        };
        const result = (await worker.request(
          { operation: "decide", candidate, input },
          async (kind, payload, callSignal) => {
            if (kind !== "model") throw new Error(`Unexpected decision worker request: ${kind}`);
            beforeModelCall();
            const response = await (
              await original(model, modelContext(payload), { ...options, signal: callSignal })
            ).result();
            addUsage(message.usage, response.usage);
            if (response.stopReason !== "stop")
              throw new Error(
                response.errorMessage ?? `DSPy model stopped with ${response.stopReason}`,
              );
            return {
              text: response.content
                .map((part) => (part.type === "text" ? part.text : ""))
                .join(""),
              usage: {
                input_tokens: response.usage.input,
                output_tokens: response.usage.output,
                total_tokens: response.usage.totalTokens,
              },
              cost: response.usage.cost.total,
            };
          },
          signal,
        )) as { action: unknown; trace: unknown };
        appendFileSync(
          tracePath,
          JSON.stringify({
            schema: "pi-dspy-gepa.trace.v1",
            input,
            ...result,
            usage: message.usage,
          }) + "\n",
          { mode: 0o600 },
        );
        signal.throwIfAborted();
        const action = validate(ActionSchema, result.action);
        const ids = new Set<string>();
        const calls = action.toolCalls.map((call) => {
          if (ids.has(call.id)) throw new Error("Duplicate tool call ID");
          ids.add(call.id);
          const content = {
            type: "toolCall" as const,
            ...call,
            id: `call_${randomUUID().replaceAll("-", "")}`,
          };
          content.arguments = validateToolCall(session.agent.state.tools, content) as Record<
            string,
            unknown
          >;
          return content;
        });
        if (action.text) message.content.push({ type: "text", text: action.text });
        message.content.push(...calls);
        message.stopReason = calls.length ? "toolUse" : "stop";
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
      } catch (error) {
        message.stopReason = signal.aborted ? "aborted" : "error";
        message.errorMessage = String(error);
        if (control.campaign.status === "active") control.stop("failed", message.errorMessage);
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } finally {
        stream.end(message);
      }
    })();
    return stream;
  };
  session.agent.toolExecution = "sequential";
  return original;
}
export const CONTROL_RULES = `Campaign control rules (fixed, above learned instructions):
Pursue only the goal in the designated worktree. The original repository and unrelated repositories are outside edit scope. Authority separately names edit, test, commit, push, pullRequest, merge, release, deploy; false forbids that action. Do not delegate coding writes. RLM children are focused analysis only.
Read applicable repository instructions and derive concrete acceptance criteria and commands before any edits. Record them through campaign acceptance in one complete call. Resolve consequential ambiguity with the user by recording a blocker. Never weaken recorded criteria, fabricate checks, or approve candidates.
The host owns tool execution and completion. An assistant response or rlm.final does not complete the campaign. Save durable notes via campaign notes; inspect the full Pi transcript at transcriptPath with IPython when useful. Retain variables across work items. After process loss, Python variables are lost but files and notes survive: inspect current artifacts and never blindly repeat the last operation.
Tool schemas and these control rules are fixed; learned instructions and demonstrations cannot override them.`;
