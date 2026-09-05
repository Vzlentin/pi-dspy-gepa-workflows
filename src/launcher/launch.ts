import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { evidenceCurrent } from "../campaign/verification.js";
import { startCampaign, ownerAlive, ownerToken, repositoryRoot } from "../campaign/workspace.js";
import { runExperiment } from "../learning/experiment.js";
import { seedCandidate } from "../runtime/policy.js";
import { openCampaign, type CampaignSession } from "../runtime/session.js";
import { CaseSchema, validate, type Campaign, type EvaluationCase } from "../state/contracts.js";
import { Store } from "../state/store.js";
import { loadConfig } from "./config.js";

export const HELP = `campaign start --repo <absolute-path> --goal <text> [--base <ref>] [--config <file>]
campaign resume <id> [--config <file>]
campaign status
campaign learning
campaign approve <candidate-id> --repo <absolute-path>
campaign bootstrap --repo <pi-ipython-rlm-path>
--state <path> selects an isolated private state database.
Inside Herdr, each stage runs as a visible pi agent in a pane beside this one. Ctrl-C pauses; resume explicitly.`;
type Config = Awaited<ReturnType<typeof loadConfig>>;
export async function launch(argv: string[]): Promise<void> {
  const args = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      goal: { type: "string" },
      base: { type: "string" },
      config: { type: "string" },
      state: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (args.values.help || !args.positionals.length) {
    console.log(HELP);
    return;
  }
  const store = new Store(args.values.state ? resolve(args.values.state) : undefined);
  try {
    const [command, id = ""] = args.positionals;
    if (command === "status") {
      for (const campaign of store.campaigns())
        console.log(
          JSON.stringify({ ...campaign, evidenceCurrent: await evidenceCurrent(campaign) }),
        );
    } else if (command === "learning") {
      console.log(JSON.stringify({ experiments: store.experiments(), trials: store.trials() }));
    } else if (command === "approve") {
      if (!id || !args.values.repo) throw new Error(HELP);
      store.approve(await repositoryRoot(args.values.repo), id);
      console.log(`Repository default is now ${id}. Existing campaigns remain pinned.`);
    } else if (command === "bootstrap") {
      if (!args.values.repo) throw new Error("Supply --repo /absolute/path/to/pi-ipython-rlm");
      const { bootstrap } = await import("../learning/historical.js");
      console.log(JSON.stringify(await bootstrap(store, args.values.repo), null, 2));
    } else await own(store, await select(store, command!, id, args.values), command === "resume");
  } finally {
    store.close();
  }
}
async function select(
  store: Store,
  command: string,
  id: string,
  values: { repo?: string; goal?: string; base?: string; config?: string },
): Promise<{ campaign: Campaign; config: Config }> {
  const config = await loadConfig(values.config);
  if (command === "start") {
    if (!values.repo || !values.goal) throw new Error(HELP);
    if (!isAbsolute(values.repo)) throw new Error("--repo must be absolute");
    const repository = await repositoryRoot(values.repo);
    const candidateId = store.defaultCandidate(repository) ?? store.addCandidate(seedCandidate());
    const campaign = await startCampaign(store, {
      repository,
      goal: values.goal,
      candidateId,
      ...(values.base ? { base: values.base } : {}),
      ...(config.constraints ? { constraints: config.constraints } : {}),
      ...(config.authority ? { authority: config.authority } : {}),
    });
    if (config.acceptance) {
      campaign.acceptance = config.acceptance;
      store.saveCampaign(campaign);
    }
    return { campaign, config };
  }
  if (command !== "resume") throw new Error(HELP);
  const found = store.getCampaign(id);
  if (!found) throw new Error("Unknown campaign ID");
  if (["completed", "cancelled"].includes(found.status))
    throw new Error(`Campaign is ${found.status}; start a new campaign`);
  if (config.acceptance || config.authority || config.constraints)
    throw new Error("Resume cannot replace the recorded campaign contract");
  return { campaign: found, config };
}
async function own(
  store: Store,
  { campaign, config }: { campaign: Campaign; config: Config },
  resume: boolean,
): Promise<void> {
  const token = ownerToken();
  store.claim(campaign.worktree, token, ownerAlive);
  const release = () => store.release(campaign.worktree, token);
  process.once("exit", release);
  try {
    campaign.status = "active";
    campaign.result = null;
    store.saveCampaign(campaign);
    await drive(store, campaign, config, resume);
  } finally {
    process.removeListener("exit", release);
    release();
  }
}
/** Run the fixed DSPy workflow to a stop, then optional post-campaign learning. */
async function drive(
  store: Store,
  campaign: Campaign,
  config: Config,
  resume: boolean,
): Promise<void> {
  const herdrPane = process.env.HERDR_ENV === "1" ? process.env.HERDR_PANE_ID : undefined;
  const live = await openCampaign({
    store,
    campaign,
    candidate: store.candidate(campaign.candidateId),
    resume,
    ...(herdrPane ? { herdrPane } : {}),
  });
  const abort = new AbortController();
  const pause = () => {
    live.control.pause();
    abort.abort(new Error("Paused by user; resume explicitly"));
  };
  process.once("SIGINT", pause);
  let last = "";
  const unsubscribe = live.control.subscribe(() => {
    const state = `${campaign.status} / ${campaign.stage}`;
    if (state !== last) console.log(`[campaign ${campaign.id}] ${(last = state)}`);
  });
  try {
    console.log(live.control.brief());
    await live.run(abort.signal);
    console.log(`Campaign ${campaign.status}.\n${campaign.result ?? ""}`.trimEnd());
    if (campaign.status === "completed" && config.allowance)
      console.log(JSON.stringify(await learn(store, live, campaign, config, abort.signal)));
  } finally {
    process.removeListener("SIGINT", pause);
    unsubscribe();
    await live.close();
  }
}
async function learn(
  store: Store,
  live: CampaignSession,
  campaign: Campaign,
  config: Config,
  signal: AbortSignal,
): Promise<unknown> {
  let cases: EvaluationCase[] = store.cases();
  if (config.casesFile)
    cases = (JSON.parse(await readFile(config.casesFile, "utf8")) as unknown[]).map((value) =>
      validate(CaseSchema, value),
    );
  return runExperiment({
    store,
    repository: campaign.repository,
    candidate: store.candidate(campaign.candidateId),
    allowance: config.allowance!,
    cases,
    campaign,
    signal,
    idle: () =>
      store
        .campaigns()
        .filter((value) => value.repository === campaign.repository)
        .every((value) => ["completed", "paused", "cancelled"].includes(value.status)),
    async reflect(prompt, reflectionSignal) {
      const response = await live.services.modelRuntime.completeSimple(
        live.model,
        {
          messages: [
            {
              role: "user",
              content: typeof prompt === "string" ? prompt : JSON.stringify(prompt),
              timestamp: Date.now(),
            },
          ],
        },
        { signal: reflectionSignal },
      );
      if (response.stopReason !== "stop")
        throw new Error(response.errorMessage ?? "GEPA reflection failed");
      return {
        text: response.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      };
    },
  });
}
