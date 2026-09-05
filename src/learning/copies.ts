import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, run } from "../campaign/process.js";

// Export only the starting tree. Git clone/worktree would expose future solutions in .git.
// The caller owns root; failed exports are left there for inspection.
export async function exportRepository(
  repository: string,
  commit: string,
  root: string,
): Promise<string> {
  const copy = join(root, "source");
  await mkdir(copy);
  const archive = join(root, "starting.tar");
  await git(repository, "archive", "--format=tar", `--output=${archive}`, commit);
  const extraction = await run("tar", ["-xf", archive, "-C", copy], root);
  if (extraction.exitCode !== 0) throw new Error(extraction.output);
  const entries = (await git(repository, "ls-tree", "-r", commit)).split("\n");
  for (const entry of entries) {
    if (!entry.startsWith("160000 ")) continue;
    const [metadata, name] = entry.split("\t");
    const subCommit = metadata!.split(" ")[2]!;
    const sub = await disposableCopy(join(repository, name!), subCommit);
    try {
      const subArchive = join(root, "submodule.tar");
      await git(sub.repository, "archive", "--format=tar", `--output=${subArchive}`, "HEAD");
      await mkdir(join(copy, name!), { recursive: true });
      const extracted = await run("tar", ["-xf", subArchive, "-C", join(copy, name!)], root);
      if (extracted.exitCode !== 0) throw new Error(extracted.output);
      await rm(subArchive);
    } finally {
      await sub.close();
    }
  }
  await rm(archive);
  await git(copy, "init", "-q");
  await git(copy, "add", "--all");
  await git(
    copy,
    "-c",
    "user.name=Campaign evaluator",
    "-c",
    "user.email=campaign@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "test: initialize evaluation starting tree",
  );
  return copy;
}

export async function disposableCopy(
  repository: string,
  commit: string,
): Promise<{ root: string; repository: string; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-campaign-trial-"));
  try {
    const copy = await exportRepository(repository, commit, root);
    return { root, repository: copy, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
