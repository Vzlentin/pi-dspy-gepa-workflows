import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { evidenceCurrent } from "../campaign/verification.js";
import { startCampaign, ownerAlive, ownerToken, repositoryRoot } from "../campaign/workspace.js";
import { runExperiment } from "../learning/experiment.js";
import { IdleLearning } from "../learning/scheduler.js";
import { seedCandidate } from "../runtime/dispatcher.js";
import { openCampaign } from "../runtime/session.js";
import { CaseSchema, validate, type Campaign, type EvaluationCase } from "../state/contracts.js";
import { Store } from "../state/store.js";
import { loadConfig } from "./config.js";

export const HELP = `campaign start --repo <absolute-path> --goal <text> [--base <ref>] [--config <file>] [--rlm <package-path>]
campaign resume <id> [--config <file>] [--rlm <package-path>]
campaign status
campaign bootstrap --repo <pi-ipython-rlm-path>
--state <path> selects an isolated private state database.
In Pi: /campaign status | pause | continue | abort | learning | approve <candidate-id>`;
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
      rlm: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (args.values.help || !args.positionals.length) {
    console.log(HELP);
    return;
  }
  const store = new Store(args.values.state ? resolve(args.values.state) : undefined);
  try {
    const command = args.positionals[0];
    if (command === "status") {
      for (const campaign of store.campaigns())
        console.log(
          JSON.stringify({ ...campaign, evidenceCurrent: await evidenceCurrent(campaign) }),
        );
      return;
    }
    if (command === "bootstrap") {
      if (!args.values.repo) throw new Error("Supply --repo /absolute/path/to/pi-ipython-rlm");
      const { bootstrap } = await import("../learning/historical.js");
      console.log(JSON.stringify(await bootstrap(store, args.values.repo), null, 2));
      return;
    }
    const config = await loadConfig(args.values.config);
    let campaign: Campaign;
    if (command === "start") {
      if (!args.values.repo || !args.values.goal) throw new Error(HELP);
      if (!isAbsolute(args.values.repo)) throw new Error("--repo must be absolute");
      const repository = await repositoryRoot(args.values.repo);
      const candidateId = store.defaultCandidate(repository) ?? store.addCandidate(seedCandidate());
      campaign = await startCampaign(store, {
        repository,
        goal: args.values.goal,
        candidateId,
        ...(args.values.base ? { base: args.values.base } : {}),
        ...(config.constraints ? { constraints: config.constraints } : {}),
        ...(config.authority ? { authority: config.authority } : {}),
      });
      if (config.acceptance) {
        campaign.acceptance = config.acceptance;
        store.saveCampaign(campaign);
      }
    } else if (command === "resume") {
      const found = store.getCampaign(args.positionals[1] ?? "");
      if (!found) throw new Error("Unknown campaign ID");
      if (["completed", "cancelled"].includes(found.status))
        throw new Error(`Campaign is ${found.status}; start a new campaign`);
      if (config.acceptance || config.authority || config.constraints)
        throw new Error("Resume cannot replace the recorded campaign contract");
      campaign = found;
    } else throw new Error(HELP);
    const token = ownerToken();
    store.claim(campaign.worktree, token, ownerAlive);
    const release = () => store.release(campaign.worktree, token);
    process.once("exit", release);
    try {
      campaign.status = "active";
      campaign.result = null;
      store.saveCampaign(campaign);
      await interact(store, campaign, config, args.values.rlm, command === "resume");
    } finally {
      process.removeListener("exit", release);
      release();
    }
  } finally {
    store.close();
  }
}
async function interact(
  store: Store,
  campaign: Campaign,
  config: Awaited<ReturnType<typeof loadConfig>>,
  rlmPackage: string | undefined,
  resume: boolean,
): Promise<void> {
  const learningMessages: string[] = [];
  const candidate = store.candidate(campaign.candidateId);
  let scheduler: IdleLearning | undefined;
  let unsubscribe: (() => void) | undefined;
  const live = await openCampaign({
    store,
    campaign,
    candidate,
    resume,
    onShutdown: async () => {
      unsubscribe?.();
      await scheduler?.close();
    },
    ...(rlmPackage ? { rlmPackage: resolve(rlmPackage) } : {}),
    commands: {
      async learning() {
        return JSON.stringify(
          { messages: learningMessages, experiments: store.experiments(), trials: store.trials() },
          null,
          2,
        );
      },
      async approve(id) {
        store.approve(campaign.repository, id);
        return `Repository default is now ${id}. This campaign remains pinned to ${campaign.candidateId}.`;
      },
    },
  });
  try {
    if (config.allowance) {
      let cases: EvaluationCase[] = store.cases();
      if (config.casesFile)
        cases = (JSON.parse(await readFile(config.casesFile, "utf8")) as unknown[]).map((value) =>
          validate(CaseSchema, value),
        );
      const allowance = config.allowance;
      scheduler = new IdleLearning(
        live.control,
        async (signal) => {
          const result = await runExperiment({
            store,
            repository: campaign.repository,
            candidate,
            allowance,
            cases,
            signal,
            idle: () =>
              !live.runtime.session.isStreaming &&
              store
                .campaigns()
                .filter((value) => value.repository === campaign.repository)
                .every((value) => ["completed", "paused", "cancelled"].includes(value.status)),
            sessionOptions: rlmPackage ? { rlmPackage: resolve(rlmPackage) } : {},
            async reflect(prompt, reflectionSignal) {
              const model = live.runtime.session.model;
              if (!model) throw new Error("Reflection model unavailable");
              const response = await live.runtime.services.modelRuntime.completeSimple(
                model,
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
                text: response.content
                  .map((part) => (part.type === "text" ? part.text : ""))
                  .join(""),
              };
            },
          });
          learningMessages.push(JSON.stringify(result));
        },
        (error) => learningMessages.push(String(error)),
        () => !live.runtime.session.isStreaming,
      );
      unsubscribe = live.runtime.session.subscribe((event) => {
        if (event.type === "agent_settled") scheduler?.update();
      });
    }
    await new InteractiveMode(live.runtime, { initialMessage: live.initialMessage }).run();
  } finally {
    unsubscribe?.();
    await scheduler?.close();
    await live.close();
  }
}
