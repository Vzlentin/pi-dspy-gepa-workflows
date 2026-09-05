import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { git, run } from "../src/campaign/process.js";
import { disposableCopy } from "../src/learning/copies.js";
import { bootstrap, shellQuote } from "../src/learning/historical.js";
import { Store } from "../src/state/store.js";

vi.mock("../src/campaign/process.js", () => ({ git: vi.fn(), run: vi.fn() }));
vi.mock("../src/learning/copies.js", () => ({ disposableCopy: vi.fn() }));

let root: string;
let store: Store;
const close = vi.fn();
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), "historical-test-"));
  store = new Store(join(root, "state.sqlite"));
  vi.mocked(git).mockImplementation(async (_repository, operation, ref) => {
    if (operation === "rev-parse") return ref === "--show-toplevel" ? root : ref!;
    if (operation === "show") return "reference test source";
    throw new Error(`Unexpected git operation: ${operation}`);
  });
  vi.mocked(disposableCopy).mockImplementation(async (_repository, commit) => {
    const directory = await mkdtemp(join(root, commit.endsWith("^") ? "starting-" : "reference-"));
    return {
      root: directory,
      repository: directory,
      close: async () => {
        close(directory);
        await rm(directory, { recursive: true });
      },
    };
  });
  vi.mocked(run).mockImplementation(async (_command, _args, cwd, options) => {
    await writeFile(options!.outputPath!, "complete check output");
    return { exitCode: cwd.includes("/starting-") ? 1 : 0, output: "complete check output" };
  });
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

it("records historical cases and complete reports from deterministic check results", async () => {
  const reports = await bootstrap(store, root);
  expect(reports).toHaveLength(3);
  expect(store.cases().map(({ role }) => role)).toEqual(["training", "validation", "heldOut"]);
  for (const role of ["training", "validation", "heldOut"]) {
    const directory = join(store.root, "historical", role);
    const report = JSON.parse(await readFile(join(directory, "validation.json"), "utf8"));
    expect(report.results.map((result: { passed: boolean }) => result.passed)).toEqual([
      false,
      true,
    ]);
    expect(report.case.repository).toBe(root);
    expect(await readFile(report.results[0].checks[0].outputPath, "utf8")).toBe(
      "complete check output",
    );
  }
  expect(
    await readFile(
      join(store.root, "historical", "validation", "test_oolong_benchmark.py"),
      "utf8",
    ),
  ).toBe("reference test source");
  expect(run).toHaveBeenCalledTimes(10);
  expect(close).toHaveBeenCalledTimes(6);
  for (const [directory] of close.mock.calls) await expect(access(directory)).rejects.toThrow();
});
it.each([0, 1])(
  "rejects cases when starting and reference checks both exit %s",
  async (exitCode) => {
    vi.mocked(run).mockResolvedValue({ exitCode, output: "check output" });
    await expect(bootstrap(store, root)).rejects.toThrow(
      "Starting must fail and reference must pass",
    );
    expect(store.cases()).toEqual([]);
    expect(close).toHaveBeenCalledTimes(2);
  },
);
it("cleans up a disposable copy when check execution throws", async () => {
  vi.mocked(run).mockRejectedValue(new Error("check execution failed"));
  await expect(bootstrap(store, root)).rejects.toThrow("check execution failed");
  expect(close).toHaveBeenCalledOnce();
  expect(store.cases()).toEqual([]);
});
it("requires an absolute repository and quotes shell paths", async () => {
  await expect(bootstrap(store, ".")).rejects.toThrow("absolute");
  expect(disposableCopy).not.toHaveBeenCalled();
  expect(shellQuote("a'b")).toBe("'a'\\''b'");
});
