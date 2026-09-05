import { randomBytes } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  SessionManager,
  type AgentSession,
  type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { run } from "../campaign/process.js";
import type { Stage } from "../state/contracts.js";

/** One stage turn. `fresh` opens a new Pi session; otherwise the open session is prompted again. */
export type StagePrompt = {
  stage: Stage;
  label: string;
  fresh: boolean;
  prompt: string;
  tools: string[];
};
export type StageReply = { text: string };
export interface StageSessions {
  prompt(request: StagePrompt, signal: AbortSignal): Promise<StageReply>;
  close(): Promise<void>;
}

/** The final assistant message of a session is the stage's LM response. */
export function lastAssistant(messages: AgentSession["messages"]): StageReply {
  const last = messages.findLast(
    (message): message is AssistantMessage => message.role === "assistant",
  );
  if (!last) throw new Error("Stage session ended without an assistant message");
  if (last.stopReason === "error" || last.stopReason === "aborted")
    throw new Error(last.errorMessage ?? `Stage session ${last.stopReason}`);
  const text = last.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
  return { text };
}
/** Every stage session keeps its transcript and inputs under `runs/<id>/sessions/<label>/`. */
async function stageDirectory(artifacts: string, label: string): Promise<string> {
  const directory = join(artifacts, "sessions", label);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
/** Headless adapter: in-process Pi SDK sessions. Used by evaluation trials and outside Herdr. */
export function sdkSessions(
  services: AgentSessionServices,
  worktree: string,
  artifacts: string,
  model?: Model<Api>,
): StageSessions {
  let current: AgentSession | undefined;
  const close = async () => {
    const session = current;
    current = undefined;
    if (!session) return;
    await session.abort();
    session.dispose();
  };
  return {
    async prompt(request, signal) {
      signal.throwIfAborted();
      if (request.fresh) {
        await close();
        const directory = await stageDirectory(artifacts, request.label);
        const created = await createAgentSessionFromServices({
          services,
          sessionManager: SessionManager.create(worktree, directory),
          tools: request.tools,
          ...(model ? { model } : {}),
        });
        await created.session.bindExtensions({});
        current = created.session;
      }
      const session = current;
      if (!session) throw new Error("No open stage session to continue");
      const abort = () => void session.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        await session.prompt(request.prompt);
        await session.agent.waitForIdle();
      } finally {
        signal.removeEventListener("abort", abort);
      }
      signal.throwIfAborted();
      return lastAssistant(session.messages);
    },
    close,
  };
}
/**
 * Herdr adapter: each stage is a real `pi` agent in a new pane beside the launcher, so the
 * human watches and can steer the live session. Prompts travel as files because stage inputs
 * (brief, diff, check output) exceed argument and paste limits. The transcript lands in the
 * run folder.
 */
export function herdrSessions(
  worktree: string,
  artifacts: string,
  callerPane: string,
  command = "herdr",
): StageSessions {
  let pane: string | undefined;
  let name: string | undefined;
  let directory = "";
  let turn = 0;
  const herdr = async (args: string[], signal?: AbortSignal) => {
    const result = await run(command, args, worktree, signal ? { signal } : {});
    if (result.exitCode !== 0)
      throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${result.output}`);
    return JSON.parse(result.output.trim().split("\n").at(-1)!) as {
      result: { pane?: { pane_id: string } };
    };
  };
  const close = async () => {
    const closing = pane;
    pane = name = undefined;
    if (closing) await herdr(["pane", "close", closing]);
  };
  const open = async (request: StagePrompt, signal: AbortSignal) => {
    await close();
    directory = await stageDirectory(artifacts, request.label);
    turn = 0;
    const split = await herdr(
      [
        "pane",
        "split",
        "--pane",
        callerPane,
        "--direction",
        "right",
        "--cwd",
        worktree,
        "--no-focus",
      ],
      signal,
    );
    pane = split.result.pane?.pane_id;
    if (!pane) throw new Error(`herdr pane split returned no pane id: ${JSON.stringify(split)}`);
    name = `${request.label}-${randomBytes(2).toString("hex")}`;
    await herdr(
      [
        "agent",
        "start",
        name,
        "--kind",
        "pi",
        "--pane",
        pane,
        "--timeout",
        "120000",
        "--",
        "--session-dir",
        directory,
        "--tools",
        request.tools.join(","),
      ],
      signal,
    );
  };
  return {
    async prompt(request, signal) {
      signal.throwIfAborted();
      if (request.fresh) await open(request, signal);
      if (!name) throw new Error("No open stage session to continue");
      const promptFile = join(directory, `prompt-${++turn}.md`);
      await writeFile(promptFile, request.prompt, { mode: 0o600 });
      await herdr(
        [
          "agent",
          "prompt",
          name,
          `Read ${promptFile} completely with the read tool (page with offset and limit if it is truncated), then carry out its instructions. End your reply with the required JSON output.`,
          "--wait",
        ],
        signal,
      );
      return lastAssistant(await transcript(directory));
    },
    close,
  };
}
async function transcript(directory: string): Promise<AgentSession["messages"]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl")).sort();
  const file = files.at(-1);
  if (!file) throw new Error(`Stage session produced no transcript in ${directory}`);
  return SessionManager.open(join(directory, file)).buildSessionContext().messages;
}
