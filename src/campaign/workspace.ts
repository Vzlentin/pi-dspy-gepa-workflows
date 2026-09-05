import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readFile, readlink, mkdir, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, dirname } from "node:path";
import { LOCAL_AUTHORITY, type Campaign, type Authority } from "../state/contracts.js";
import type { Store } from "../state/store.js";
import { git } from "./process.js";

export async function repositoryRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Repository path must be absolute");
  return realpath(await git(path, "rev-parse", "--show-toplevel"));
}

export async function startCampaign(
  store: Store,
  input: {
    repository: string;
    goal: string;
    candidateId: string;
    base?: string;
    constraints?: string[];
    authority?: Authority;
  },
): Promise<Campaign> {
  if (!isAbsolute(input.repository) || !input.goal.trim())
    throw new Error("An absolute repository path and nonempty goal are required");
  const repository = await repositoryRoot(input.repository);
  const baseRef = input.base ?? "HEAD";
  const baseCommit = await git(
    repository,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${baseRef}^{commit}`,
  );
  store.candidate(input.candidateId);
  const id = randomUUID();
  const runPath = store.runPath(id);
  const worktree = join(runPath, "worktree");
  await mkdir(runPath, { recursive: true, mode: 0o700 });
  await git(repository, "worktree", "add", "--detach", worktree, baseCommit);
  const constraints = [...(await repositoryInstructions(repository)), ...(input.constraints ?? [])];
  const campaign: Campaign = {
    schema: "pi-dspy-gepa.campaign.v1",
    id,
    repository,
    baseCommit,
    baseRef,
    worktree,
    sessionPath: null,
    goal: input.goal,
    constraints,
    authority: input.authority ?? { ...LOCAL_AUTHORITY },
    candidateId: input.candidateId,
    status: "active",
    stage: "plan",
    plan: null,
    notes: [],
    acceptance: null,
    evidence: null,
    result: null,
    createdAt: new Date().toISOString(),
  };
  store.saveCampaign(campaign);
  return campaign;
}
export async function treeSnapshot(
  worktree: string,
  base = "HEAD",
): Promise<{ fingerprint: string; diff: string }> {
  const files = (
    await git(worktree, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
  )
    .split("\0")
    .filter(Boolean);
  const hash = createHash("sha256");
  const untracked = new Set(
    (await git(worktree, "ls-files", "--others", "--exclude-standard", "-z")).split("\0"),
  );
  let diff = await git(worktree, "diff", "--binary", "--no-ext-diff", base, "--");
  for (const name of [...new Set(files)].sort()) {
    hash.update(JSON.stringify(name));
    try {
      const file = join(worktree, name);
      const stat = await lstat(file);
      let content: Buffer;
      if (stat.isDirectory()) {
        const submodule = await treeSnapshot(file);
        content = Buffer.from(
          JSON.stringify({
            commit: await git(file, "rev-parse", "HEAD"),
            fingerprint: submodule.fingerprint,
          }),
        );
        diff += `\nSubmodule ${JSON.stringify(name)}:\n${submodule.diff}`;
      } else
        content = stat.isSymbolicLink() ? Buffer.from(await readlink(file)) : await readFile(file);
      hash.update(String(stat.mode));
      hash.update(String(content.length));
      hash.update(content);
      if (untracked.has(name))
        diff += `\nUntracked file ${JSON.stringify(name)}:\n${content.toString("utf8")}\n`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("deleted");
    }
  }
  return { fingerprint: hash.digest("hex"), diff };
}
async function repositoryInstructions(repository: string): Promise<string[]> {
  const instructions: string[] = [];
  let current = repository;
  while (true) {
    const file = join(current, "AGENTS.md");
    try {
      instructions.unshift(
        `Repository instructions from ${file}:\n${await readFile(file, "utf8")}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return instructions;
    current = parent;
  }
}
function processIdentity(pid: number): string {
  // Linux start-time prevents a recycled PID from retaining campaign ownership.
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19]!;
  } catch {
    return "portable";
  }
}
export function ownerToken(): string {
  return JSON.stringify({
    schema: "pi-dspy-gepa.owner.v1",
    host: hostname(),
    pid: process.pid,
    start: processIdentity(process.pid),
    nonce: randomUUID(),
  });
}
export function ownerAlive(token: string): boolean {
  const owner = JSON.parse(token) as { host: string; pid: number; start: string };
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return processIdentity(owner.pid) === owner.start;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
