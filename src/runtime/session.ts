import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSessionServices,
  type DefaultResourceLoader,
  type ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CampaignControl } from "../campaign/control.js";
import type { Reviewer } from "../campaign/verification.js";
import {
  CandidateSchema,
  candidateId,
  validate,
  type Campaign,
  type Candidate,
} from "../state/contracts.js";
import type { Store } from "../state/store.js";
import { accountModels, UsageLedger } from "./accounting.js";
import { independentEvaluator } from "./evaluator.js";
import { fixedProgramDigest, fixedStageInstructions, stageTools } from "./policy.js";
import { PythonWorker, type Exchange, type Worker } from "./python.js";
import { herdrSessions, sdkSessions, type StageSessions } from "./sessions.js";

type DefaultResourceLoaderOptions = Omit<
  ConstructorParameters<typeof DefaultResourceLoader>[0],
  "cwd" | "agentDir"
>;
export type SessionOptions = {
  store: Store;
  campaign: Campaign;
  candidate: Candidate;
  resume?: boolean;
  agentDir?: string;
  /** Herdr pane to split beside; when set, stages run as visible `pi` agents in new panes. */
  herdrPane?: string;
  modelRuntime?: ModelRuntime;
  model?: Model<Api>;
  settingsManager?: SettingsManager;
  resourceLoaderOptions?: DefaultResourceLoaderOptions;
  worker?: Worker;
  evaluator?: Reviewer;
  sessions?: StageSessions;
  beforeModelCall?: () => void;
  signal?: AbortSignal;
};
export type CampaignSession = {
  control: CampaignControl;
  services: AgentSessionServices;
  model: Model<Api>;
  ledger: UsageLedger;
  /** Drive the DSPy workflow until the campaign leaves `active`. */
  run(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
};
/** Trusted in-process worker protocol; `output` is schema-validated by `CampaignControl.record`. */
type HostRequest = { fresh?: boolean; prompt?: string; output?: unknown };
export async function openCampaign(options: SessionOptions): Promise<CampaignSession> {
  const { store, campaign, candidate } = options;
  validate(CandidateSchema, candidate);
  if (candidateId(candidate) !== campaign.candidateId)
    throw new Error("Candidate identity does not match the pinned campaign");
  if (candidate.provenance.programDigest !== fixedProgramDigest())
    throw new Error(
      "Candidate fixed-program identity does not match this runtime. Start a new campaign with --state /absolute/path/to/fresh-directory/state.sqlite. Existing state and worktrees have been preserved.",
    );
  const artifacts = store.runPath(campaign.id);
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const ledger = new UsageLedger();
  const services = await createAgentSessionServices({
    cwd: campaign.worktree,
    agentDir: options.agentDir ?? getAgentDir(),
    ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
    ...(options.settingsManager ? { settingsManager: options.settingsManager } : {}),
    ...(options.resourceLoaderOptions
      ? { resourceLoaderOptions: options.resourceLoaderOptions }
      : {}),
  });
  const unaccount = accountModels(
    services.modelRuntime,
    options.beforeModelCall ?? (() => {}),
    (usage) => ledger.record(usage),
    options.signal,
  );
  const worker = options.worker ?? new PythonWorker(join(artifacts, "python.log"));
  let sessions: StageSessions | undefined;
  const dispose = async () => {
    try {
      await sessions?.close();
    } finally {
      try {
        await worker.close();
      } finally {
        unaccount();
      }
    }
  };
  try {
    const model = options.model ?? (await defaultModel(services, campaign.worktree));
    const control = new CampaignControl(
      store,
      campaign,
      options.evaluator ?? independentEvaluator(services.modelRuntime, model),
      artifacts,
    );
    sessions =
      options.sessions ??
      (options.herdrPane
        ? herdrSessions(campaign.worktree, artifacts, options.herdrPane)
        : sdkSessions(services, campaign.worktree, artifacts, model));
    if (options.resume) {
      campaign.notes.push(
        `Resumed: the ${campaign.stage} stage restarts in a fresh session. Inspect the worktree for partial work before continuing.`,
      );
      control.changed();
    }
    const host = campaignHost(control, sessions, join(artifacts, "dspy-traces.jsonl"));
    return {
      control,
      services,
      model,
      ledger,
      async run(signal) {
        const abort = () => {
          if (campaign.status === "active")
            control.stop("cancelled", String(signal.reason ?? "Cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          await worker.request({ operation: "campaign", candidate }, host, signal);
        } catch (error) {
          if (campaign.status === "active") control.stop("failed", String(error));
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
      async close() {
        control.pause();
        await dispose();
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
/**
 * Pi's own default-model resolution. The SDK does not export `findInitialModel`, so a throwaway
 * in-memory session is the supported way to read the configured model.
 */
async function defaultModel(services: AgentSessionServices, cwd: string): Promise<Model<Api>> {
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    tools: [],
  });
  try {
    if (!session.model) throw new Error("No Pi model is configured for campaign sessions");
    return session.model;
  } finally {
    session.dispose();
  }
}
/** Answers the DSPy program's host requests: status, stage inputs, sessions, records. */
function campaignHost(
  control: CampaignControl,
  sessions: StageSessions,
  tracePath: string,
): Exchange {
  let count = 0;
  let label = "";
  return async (kind, payload, signal) => {
    const request = payload as HostRequest;
    const { stage, authority } = control.campaign;
    switch (kind) {
      case "status":
        return control.status();
      case "inputs": {
        const state = await control.begin(signal);
        return {
          ...state,
          inheritedInstructions: fixedStageInstructions(stage),
          brief: control.brief(),
        };
      }
      case "session":
        if (request.fresh) label = `${stage}-${++count}`;
        return sessions.prompt(
          {
            stage,
            label,
            fresh: !!request.fresh,
            prompt: request.prompt ?? "",
            tools: stageTools(stage, authority),
          },
          signal,
        );
      case "record":
        appendFileSync(
          tracePath,
          JSON.stringify({ schema: "pi-dspy-gepa.trace.v1", stage, ...request }) + "\n",
          { mode: 0o600 },
        );
        return control.record(request.output);
      default:
        throw new Error(`Unexpected campaign worker request: ${kind}`);
    }
  };
}
