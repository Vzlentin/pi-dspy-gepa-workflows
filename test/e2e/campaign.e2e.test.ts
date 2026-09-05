import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { fixedStageInstructions, seedCandidate } from "../../src/runtime/policy.js";
import { PythonWorker } from "../../src/runtime/python.js";
import { openCampaign } from "../../src/runtime/session.js";
import { STAGES } from "../../src/state/contracts.js";
import { assistant, fixture, plan, report, review } from "../helpers.js";
import { runtimeFixture } from "../runtime-fixture.js";

it("embeds Pi 0.85.0 with matching dependency pins and candidate provenance", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const version = seedCandidate().provenance.pi;
  expect(version).toBe("0.85.0");
  for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
    const dependency = `@earendil-works/${name}`;
    const installed = JSON.parse(
      await readFile(new URL("../package.json", import.meta.resolve(dependency)), "utf8"),
    );
    expect(installed.version).toBe(version);
    expect(manifest.devDependencies[dependency]).toBe(version);
    expect(manifest.peerDependencies[dependency]).toBe(version);
  }
});

it("real DSPy program drives fresh real Pi sessions per stage; Pi runs the tools, the host verifies", async () => {
  const candidate = seedCandidate();
  for (const stage of STAGES)
    candidate.stages[stage].instructions = `Learned ${stage} instructions.`;
  const f = await fixture(candidate);
  try {
    const outputs = {
      plan: { plan: { ...plan, commands: ['test "$(cat source.txt)" = finished'] } },
      implement: { report },
      review: { review },
      fix: { report },
    };
    // The learned DSPy instructions lead the fresh session's opening user prompt.
    const stageOf = (context: Context) =>
      /Learned (\w+) instructions/.exec(JSON.stringify(context.messages[0]))?.[1];
    const respond = (context: Context) => {
      const system = context.systemPrompt ?? "";
      if (system.startsWith("You are an independent")) return assistant(JSON.stringify(review));
      const stage = stageOf(context) as keyof typeof outputs;
      expect(stage, JSON.stringify(context.messages[0])).toBeTruthy();
      if (stage === "implement" && context.messages.at(-1)?.role === "user")
        return assistant("", [
          {
            type: "toolCall",
            id: "write-1",
            name: "write",
            arguments: { path: "source.txt", content: "finished" },
          },
        ]);
      return assistant(JSON.stringify(outputs[stage]));
    };
    const { model: _model, ...options } = await runtimeFixture(f.root, respond);
    const live = await openCampaign({
      ...f,
      ...options,
      worker: new PythonWorker(join(f.root, "dspy.log")),
    });
    try {
      await live.run(AbortSignal.timeout(90000));
      expect(f.campaign.status, f.campaign.result ?? "").toBe("completed");
      expect(await readFile(join(f.campaign.worktree, "source.txt"), "utf8")).toBe("finished");
      expect(await readFile(join(f.repository, "source.txt"), "utf8")).toBe("starting\n");
      const stages = options.requests.map((context) => stageOf(context) ?? "evaluator");
      expect(stages).toEqual(["plan", "implement", "implement", "evaluator", "review"]);
      expect(options.requests[0]!.tools?.map((tool) => tool.name)).toEqual([
        "read",
        "grep",
        "find",
        "ls",
      ]);
      expect(options.requests[3]!.tools ?? []).toHaveLength(0);
      expect(options.requests[0]!.systemPrompt).toContain(
        options.requests[4]!.systemPrompt!.split("\n")[0],
      );
      const reviewPrompt = JSON.stringify(options.requests[4]!.messages);
      expect(reviewPrompt).toContain("+finished");
      expect(reviewPrompt).toContain("Exit code: 0");
      expect(reviewPrompt).not.toContain("write-1");
      const directory = join(f.store.root, "runs", f.campaign.id);
      for (const label of ["plan-1", "implement-2", "review-3"])
        expect(
          (await readdir(join(directory, "sessions", label))).some((n) => n.endsWith(".jsonl")),
        ).toBe(true);
      const traces = (await readFile(join(directory, "dspy-traces.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(traces.map((trace) => trace.stage)).toEqual(["plan", "implement", "review"]);
      for (const trace of traces)
        expect(trace.input.inheritedInstructions).toBe(fixedStageInstructions(trace.stage));
      expect(live.ledger.calls).toBe(5);
    } finally {
      await live.close();
    }
  } finally {
    await f.close();
  }
});
