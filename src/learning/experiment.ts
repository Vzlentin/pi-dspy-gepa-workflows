import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PythonWorker, type Worker } from "../runtime/python.js";
import {
  AllowanceSchema,
  CandidateSchema,
  digest,
  validate,
  type Allowance,
  type Candidate,
  type EvaluationCase,
} from "../state/contracts.js";
import type { Store } from "../state/store.js";
import { feedback, runTrial, type TrialRunner, type TrialOptions } from "./trial.js";

export class AllowanceMeter {
  trials = 0;
  modelCalls = 0;
  constructor(readonly allowance: Allowance) {
    validate(AllowanceSchema, allowance);
  }
  admit(): void {
    if (this.trials >= this.allowance.maxTrials)
      throw new Error("Experiment trial allowance exhausted");
    this.trials++;
  }
  modelCall(): void {
    if (this.modelCalls >= this.allowance.maxModelCalls)
      throw new Error("Experiment model-call allowance exhausted");
    this.modelCalls++;
  }
}
export interface ExperimentOptions {
  store: Store;
  repository: string;
  candidate: Candidate;
  allowance: Allowance;
  cases: EvaluationCase[];
  signal: AbortSignal;
  idle: () => boolean;
  reflect: (prompt: unknown, signal: AbortSignal) => Promise<{ text: string }>;
  worker?: Worker;
  trialRunner?: TrialRunner;
  sessionOptions?: TrialOptions["sessionOptions"];
}
export async function runExperiment(options: ExperimentOptions): Promise<{
  id: string;
  candidates: string[];
  trials: number;
  modelCalls: number;
  repeated: boolean;
}> {
  const cases = options.cases.filter(
    (value) => value.role !== "heldOut" && value.repository === options.repository,
  );
  if (
    !cases.some((value) => value.role === "training") ||
    !cases.some((value) => value.role === "validation")
  )
    throw new Error("Learning requires training and validation cases");
  const id = digest({
    candidate: options.candidate,
    cases,
    allowance: options.allowance,
    repository: options.repository,
  });
  const result = { id, candidates: [] as string[], trials: 0, modelCalls: 0, repeated: false };
  const meter = new AllowanceMeter(options.allowance);
  const activity = new AbortController();
  const signal = AbortSignal.any([options.signal, activity.signal]);
  const assertIdle = () => {
    if (!options.idle())
      activity.abort(new Error("Learning runs only while campaigns are completed or paused"));
    signal.throwIfAborted();
  };
  assertIdle();
  if (
    !options.store.startExperiment(id, options.repository, {
      schema: "pi-dspy-gepa.experiment.v1",
      allowance: options.allowance,
      candidateId: digest(options.candidate),
      caseIds: cases.map((value) => value.id),
    })
  ) {
    result.repeated = true;
    return result;
  }
  const artifacts = join(options.store.root, "experiments", id);
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const worker = options.worker ?? new PythonWorker(join(artifacts, "gepa.log"));
  const beforeModelCall = () => {
    assertIdle();
    meter.modelCall();
  };
  let errorMessage: string | null = null;
  const began = Date.now();
  // ponytail: poll shared activity every 250ms; use notifications if tighter cancellation is needed.
  const monitor = setInterval(() => {
    try {
      assertIdle();
    } catch (error) {
      activity.abort(error);
    }
  }, 250).unref();
  try {
    assertIdle();
    const proposed = (await worker.request(
      {
        operation: "learn",
        candidate: options.candidate,
        cases,
        maxTrials: options.allowance.maxTrials,
      },
      async (kind, payload, signal) => {
        assertIdle();
        if (kind === "reflection") {
          beforeModelCall();
          return options.reflect((payload as { prompt: unknown }).prompt, signal);
        }
        if (kind !== "evaluate") throw new Error(`Unexpected optimizer request: ${kind}`);
        const request = payload as {
          cases: EvaluationCase[];
          components: Pick<Candidate, "instructions" | "demonstrations">;
        };
        const candidate = validate(CandidateSchema, {
          ...options.candidate,
          ...request.components,
          repository: options.repository,
        });
        if (
          Object.keys(request.components).some(
            (key) => !["instructions", "demonstrations"].includes(key),
          )
        )
          throw new Error("Optimizer attempted to change a fixed contract");
        const candidateId = options.store.addCandidate(candidate);
        if (!result.candidates.includes(candidateId)) result.candidates.push(candidateId);
        const outcomes: unknown[] = Array.from({ length: request.cases.length });
        let next = 0;
        const evaluate = async () => {
          while (next < request.cases.length) {
            const index = next++;
            const evaluationCase = request.cases[index]!;
            if (!cases.some((value) => digest(value) === digest(evaluationCase)))
              throw new Error("Optimizer requested an unknown or held-out case");
            assertIdle();
            meter.admit();
            const deadline = AbortSignal.timeout(options.allowance.trialDeadlineMs);
            const trial = await (options.trialRunner ?? runTrial)({
              experimentId: id,
              candidate,
              case: evaluationCase,
              artifacts,
              signal: AbortSignal.any([signal, deadline]),
              beforeModelCall,
              ...(options.sessionOptions ? { sessionOptions: options.sessionOptions } : {}),
            });
            options.store.addTrial(trial);
            outcomes[index] = { ...trial, feedback: await feedback(trial) };
          }
        };
        const settled = await Promise.allSettled(
          Array.from(
            { length: Math.min(options.allowance.concurrency, request.cases.length) },
            evaluate,
          ),
        );
        const failure = settled.find((value) => value.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        return outcomes;
      },
      signal,
    )) as { candidates: Pick<Candidate, "instructions" | "demonstrations">[] };
    signal.throwIfAborted();
    for (const learned of proposed.candidates) {
      if (Object.keys(learned).some((key) => !["instructions", "demonstrations"].includes(key)))
        throw new Error("Optimizer attempted to change a fixed contract");
      const candidateId = options.store.addCandidate(
        validate(CandidateSchema, {
          ...options.candidate,
          ...learned,
          repository: options.repository,
        }),
      );
      if (!result.candidates.includes(candidateId)) result.candidates.push(candidateId);
    }
  } catch (error) {
    errorMessage = String(error);
    throw error;
  } finally {
    clearInterval(monitor);
    await worker.close();
    result.trials = meter.trials;
    result.modelCalls = meter.modelCalls;
    options.store.finishExperiment(id, {
      ...result,
      error: errorMessage,
      status: signal.aborted ? "cancelled" : errorMessage ? "error" : "completed",
      durationMs: Date.now() - began,
    });
  }
  return result;
}
