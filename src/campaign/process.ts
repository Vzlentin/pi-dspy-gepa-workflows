import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";

export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
export async function run(
  command: string,
  args: string[],
  cwd: string,
  options: { signal?: AbortSignal; outputPath?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ exitCode: number | null; output: string }> {
  options.signal?.throwIfAborted();
  const child = spawn(command, args, {
    cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onExit = () => killTree(child, "SIGKILL");
  process.once("exit", onExit);
  const file = options.outputPath
    ? createWriteStream(options.outputPath, { mode: 0o600 })
    : undefined;
  const chunks: Buffer[] = [];
  const output = (chunk: Buffer) => {
    chunks.push(chunk);
    file?.write(chunk);
  };
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    killTree(child);
    escalation = setTimeout(() => killTree(child, "SIGKILL"), 1000);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { exitCode, output: Buffer.concat(chunks).toString("utf8") };
  } finally {
    process.removeListener("exit", onExit);
    if (escalation) {
      clearTimeout(escalation);
      killTree(child, "SIGKILL");
    }
    options.signal?.removeEventListener("abort", abort);
    if (file) {
      file.end();
      await finished(file);
    }
  }
}
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run("git", args, cwd);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.output}`);
  return result.output.trimEnd();
}
