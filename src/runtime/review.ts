import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Reviewer } from "../campaign/verification.js";
import { ReviewSchema, validate, type Candidate } from "../state/contracts.js";
import { fixedStageInstructions } from "./dispatcher.js";
import type { Worker } from "./python.js";

export function workflowReviewer(
  worker: Worker,
  candidate: Candidate,
  tracePath: string,
  complete: (payload: unknown, signal: AbortSignal) => Promise<AssistantMessage>,
): Reviewer {
  return async (evidence, signal) => {
    const checks = await Promise.all(
      evidence.checks.map(async (check) => ({
        ...check,
        output: await readFile(check.outputPath, "utf8"),
      })),
    );
    const input = {
      inheritedInstructions: fixedStageInstructions("review"),
      brief: JSON.stringify({
        goal: evidence.goal,
        plan: evidence.plan,
        constraints: evidence.constraints,
        criteria: evidence.criteria,
      }),
      context: JSON.stringify({ diff: evidence.diff, checks }),
      tools: "[]",
    };
    const result = (await worker.request(
      { operation: "decide", stage: "review", candidate, input },
      async (kind, payload, callSignal) => {
        if (kind !== "model") throw new Error(`Unexpected review worker request: ${kind}`);
        const response = await complete(payload, callSignal);
        if (response.stopReason !== "stop")
          throw new Error(response.errorMessage ?? "Workflow review failed");
        return {
          text: response.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
          usage: {
            input_tokens: response.usage.input,
            output_tokens: response.usage.output,
            total_tokens: response.usage.totalTokens,
          },
          cost: response.usage.cost.total,
        };
      },
      signal,
    )) as { review: unknown; trace: unknown };
    appendFileSync(
      tracePath,
      JSON.stringify({ schema: "pi-dspy-gepa.trace.v1", stage: "review", input, ...result }) + "\n",
      { mode: 0o600 },
    );
    signal.throwIfAborted();
    return validate(ReviewSchema, result.review);
  };
}
