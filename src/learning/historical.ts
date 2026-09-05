import { mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { git, run } from "../campaign/process.js";
import { repositoryRoot } from "../campaign/workspace.js";
import { PACKAGE_ROOT } from "../runtime/python.js";
import { type EvaluationCase } from "../state/contracts.js";
import { Store } from "../state/store.js";
import { disposableCopy } from "./copies.js";

const HISTORY = [
  {
    role: "training",
    commit: "de0dc02e9b063afa516bf83b972cbb68ffde2e53",
    task: "Keep RLM gather progress visible above prior output, display a Pi widget while gathering, and clear it on success or failure.",
    tests: [],
  },
  {
    role: "validation",
    commit: "d8d03d9c230b7a4b94cd7f36baccafc511e0aa3e",
    task: "Add OOLONG and LongBench code-QA benchmark harnesses with paper profiles, deterministic parsers/scorers, context files that exclude gold answers, event usage accounting, and dry-run support.",
    tests: ["tests/test_oolong_benchmark.py", "tests/test_longbench_benchmark.py"],
  },
  {
    role: "heldOut",
    commit: "91861ba9427605efc67d88968339181910a4ed19",
    task: "Refactor IPython bridge lifecycle and child execution into focused modules. Abort all active child requests on cancellation; preserve tool-free child model routing, provider-specific reasoning options, and complete cleanup.",
    tests: ["tests/test_host_cancellation.mjs", "tests/test_child_completion.mjs"],
  },
] as const;
export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export async function bootstrap(store: Store, repository: string): Promise<unknown> {
  if (!isAbsolute(repository)) throw new Error("Historical repository path must be absolute");
  repository = await repositoryRoot(repository);
  const output = join(store.root, "historical");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const reports = [];
  for (const definition of HISTORY) {
    const startingCommit = await git(repository, "rev-parse", `${definition.commit}^`);
    const directory = join(output, definition.role);
    await mkdir(directory, { recursive: true });
    const commands: string[] = [];
    if (definition.role === "training")
      commands.push(
        `node --experimental-transform-types --no-warnings ${shellQuote(join(PACKAGE_ROOT, "fixtures/historical/gather.mjs"))}`,
      );
    for (const test of definition.tests) {
      const file = join(directory, test.split("/").at(-1)!);
      await writeFile(file, await git(repository, "show", `${definition.commit}:${test}`));
      if (test.endsWith(".py"))
        commands.push(`PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. python3 ${shellQuote(file)}`);
      else
        commands.push(
          `node --experimental-transform-types --no-warnings ${shellQuote(join(PACKAGE_ROOT, "fixtures/historical/node-check.mjs"))} ${shellQuote(file)}`,
        );
    }
    const evaluationCase: EvaluationCase = {
      schema: "pi-dspy-gepa.evaluation-case.v1",
      id: `rlm-${definition.role}-${definition.commit}`,
      role: definition.role,
      repository,
      startingCommit,
      task: definition.task,
      setup: [`ln -s ${shellQuote(join(PACKAGE_ROOT, "node_modules"))} node_modules`],
      acceptance: { criteria: [definition.task], commands },
      rubric:
        "Assess completeness against the task, functional correctness, and maintainability without unnecessary complexity. Required deterministic checks must pass.",
    };
    const results = [];
    for (const [label, commit] of [
      ["starting", startingCommit],
      ["reference", definition.commit],
    ]) {
      const copy = await disposableCopy(repository, commit!);
      try {
        await symlink(join(PACKAGE_ROOT, "node_modules"), join(copy.repository, "node_modules"));
        const checks = [];
        for (const [index, command] of commands.entries()) {
          const outputPath = join(directory, `${label}-${index}.log`);
          const result = await run("/bin/sh", ["-c", command], copy.repository, { outputPath });
          checks.push({ exitCode: result.exitCode, outputPath });
        }
        const passed = checks.every((check) => check.exitCode === 0);
        results.push({ label, commit, passed, checks });
      } finally {
        await copy.close();
      }
    }
    const packageManifest = JSON.parse(
      await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string>; peerDependencies: Record<string, string> };
    const report = {
      schema: "pi-dspy-gepa.historical-validation.v1",
      case: evaluationCase,
      runtime: {
        node: process.versions.node,
        dependencies: packageManifest.dependencies,
        peerDependencies: packageManifest.peerDependencies,
      },
      submoduleCommit:
        definition.role === "heldOut" ? "ff13f9201007369ebcde0dd5b87b0d804e492e89" : null,
      results,
    };
    await writeFile(join(directory, "validation.json"), JSON.stringify(report, null, 2));
    if (results[0]!.passed || !results[1]!.passed)
      throw new Error(
        `Historical ${definition.role} validation failed; inspect ${directory}. Starting must fail and reference must pass.`,
      );
    store.addCase(evaluationCase);
    reports.push(report);
  }
  return reports;
}
