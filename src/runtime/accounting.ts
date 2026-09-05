import {
  createAssistantMessageEventStream,
  type Usage,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { addUsage, zeroUsage } from "./dispatcher.js";

const accountedRuntimes = new WeakSet<ModelRuntime>();

export function accountModels(
  runtime: ModelRuntime,
  admit: () => void,
  record: (usage: Usage) => void,
  campaignSignal?: AbortSignal,
): () => void {
  if (accountedRuntimes.has(runtime))
    throw new Error("Model runtime already belongs to an open campaign; use a separate runtime");
  accountedRuntimes.add(runtime);
  const stream = runtime.stream;
  const streamSimple = runtime.streamSimple;
  function instrument<T extends typeof stream | typeof streamSimple>(original: T): T {
    return ((model: Parameters<T>[0], context: Parameters<T>[1], options: Parameters<T>[2]) => {
      try {
        campaignSignal?.throwIfAborted();
        admit();
        const signals = [campaignSignal, options?.signal].filter(
          (value): value is AbortSignal => !!value,
        );
        // Preserve each API's native options; only add the host cancellation signal.
        const result = Reflect.apply(original, runtime, [
          model,
          context,
          { ...options, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) },
        ]) as AssistantMessageEventStream;
        void result.result().then((message) => record(message.usage));
        return result;
      } catch (error) {
        const result = createAssistantMessageEventStream();
        const message = {
          role: "assistant" as const,
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: zeroUsage(),
          stopReason: "error" as const,
          errorMessage: String(error),
          timestamp: Date.now(),
        };
        result.push({ type: "error", reason: "error", error: message });
        result.end(message);
        return result;
      }
    }) as T;
  }
  runtime.stream = instrument(stream);
  runtime.streamSimple = instrument(streamSimple);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    runtime.stream = stream;
    runtime.streamSimple = streamSimple;
    accountedRuntimes.delete(runtime);
  };
}
export class UsageLedger {
  readonly usage = zeroUsage();
  calls = 0;
  record(usage: Usage): void {
    this.calls++;
    addUsage(this.usage, usage);
  }
}
