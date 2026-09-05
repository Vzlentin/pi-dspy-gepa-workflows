import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { killTree } from "../campaign/process.js";

export const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export type Exchange = (kind: string, payload: unknown, signal: AbortSignal) => Promise<unknown>;
export interface Worker {
  request(payload: unknown, exchange: Exchange, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
export class PythonWorker implements Worker {
  private child: ChildProcessWithoutNullStreams;
  private pending:
    | {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        exchange: Exchange;
        signal: AbortSignal;
      }
    | undefined;
  private exited: Promise<void>;
  private dead = false;
  private readonly shutdown = new AbortController();
  private readonly incoming = new Set<Promise<void>>();
  private readonly exitHandler = () => killTree(this.child, "SIGKILL");
  constructor(
    readonly logPath: string,
    command = "uv",
    args = ["run", "--frozen", "--project", PACKAGE_ROOT, "python", "-m", "pi_dspy_gepa.worker"],
  ) {
    this.child = spawn(command, args, {
      cwd: dirname(logPath),
      detached: true,
      env: {
        ...process.env,
        PYTHONPATH: `${PACKAGE_ROOT}/python`,
        PYTHONUNBUFFERED: "1",
        DSPY_CACHEDIR: join(dirname(logPath), "dspy-cache"),
      },
      stdio: "pipe",
    });
    this.child.stderr.on("data", (chunk) => appendFileSync(logPath, chunk));
    process.once("exit", this.exitHandler);
    this.exited = new Promise((resolve) =>
      this.child.once("close", () => {
        this.fail(new Error("Python worker exited; resume explicitly, no tool call was replayed"));
        resolve();
      }),
    );
    this.child.on("error", (error) => this.fail(error));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const task = this.receive(line);
      this.incoming.add(task);
      void task.finally(() => this.incoming.delete(task));
    });
  }
  private fail(error: Error): void {
    this.dead = true;
    this.pending?.reject(error);
    this.pending = undefined;
  }
  private async receive(line: string): Promise<void> {
    try {
      const message = JSON.parse(line) as {
        schema: string;
        kind: string;
        payload: unknown;
        result: unknown;
        error?: string;
      };
      const pending = this.pending;
      if (!pending) throw new Error("Unsolicited worker output");
      if (message.schema === "pi-dspy-gepa.python-response.v1") {
        this.pending = undefined;
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      } else if (message.schema === "pi-dspy-gepa.python-request.v1") {
        try {
          const result = await pending.exchange(
            message.kind,
            message.payload,
            AbortSignal.any([pending.signal, this.shutdown.signal]),
          );
          if (!this.dead) this.child.stdin.write(JSON.stringify({ result }) + "\n");
        } catch (error) {
          if (!this.dead) this.child.stdin.write(JSON.stringify({ error: String(error) }) + "\n");
        }
      } else throw new Error("Invalid Python worker protocol");
    } catch (error) {
      this.fail(error as Error);
      killTree(this.child);
    }
  }
  async request(payload: unknown, exchange: Exchange, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (this.dead) throw new Error("Python worker is unavailable; resume explicitly");
    if (this.pending) throw new Error("Only one campaign decision may run at a time");
    const abort = () => {
      this.fail(new Error("Python worker aborted"));
      void this.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        this.pending = { resolve, reject, exchange, signal };
        this.child.stdin.write(JSON.stringify(payload) + "\n");
      });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async close(): Promise<void> {
    this.shutdown.abort(new Error("Python worker closed"));
    this.fail(new Error("Python worker closed"));
    killTree(this.child);
    const escalation = setTimeout(() => killTree(this.child, "SIGKILL"), 1000);
    try {
      await this.exited;
      await Promise.allSettled(this.incoming);
    } finally {
      clearTimeout(escalation);
      process.removeListener("exit", this.exitHandler);
    }
  }
}
