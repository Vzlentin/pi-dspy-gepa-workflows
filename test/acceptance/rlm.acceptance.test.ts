import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { git } from "../../src/campaign/process.js";
import { bootstrap } from "../../src/learning/historical.js";
import { openCampaign } from "../../src/runtime/session.js";
import { fixture, call, FakeWorker, review } from "../helpers.js";
import { runtimeFixture } from "../runtime-fixture.js";

it("real Pi SDK, real persistent RLM kernel, deterministic DSPy actions and tool-free fake children", async () => {
  const f = await fixture();
  try {
    const options = await runtimeFixture(f.root, true);
    const worker = new FakeWorker([
      call("campaign", {
        action: "plan",
        text: "Exercise shared scratchpad variables and the focused child, then review.",
        acceptance: {
          criteria: ["Complete two work items with shared variables"],
          commands: ["true"],
        },
      }),
      call("ipython", { code: "counter = 41\nawait rlm.final('first work item')" }),
      call("ipython", {
        code: "assert counter == 41\ncounter += 1\nh = await rlm.spawn('Reply with fake summary')\nr = await rlm.gather([h])\nassert r[0]['text'] == 'fake summary', r\nawait rlm.final({'counter': counter, 'child': r[0]['text']})",
      }),
      call("campaign", { action: "review" }),
    ]);
    const live = await openCampaign({ ...f, ...options, worker, reviewer: async () => review });
    const toolErrors: unknown[] = [];
    live.runtime.session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.isError) toolErrors.push(event.result);
    });
    try {
      await live.runHeadless(AbortSignal.timeout(90000));
      expect(toolErrors).toEqual([]);
      expect(f.campaign.status, f.campaign.result ?? "").toBe("completed");
      expect(worker.calls).toHaveLength(4);
      expect(options.requests).toHaveLength(1);
      expect(options.requests[0]!.tools ?? []).toHaveLength(0);
      const transcript = await readFile(f.campaign.sessionPath!, "utf8");
      expect(transcript).toContain('\\"counter\\": 42');
      expect(transcript).toContain("first work item");
      expect(await readFile(join(f.repository, "source.txt"), "utf8")).toBe("starting\n");
    } finally {
      await live.close();
    }
  } finally {
    await f.close();
  }
});
it("historical references pass while starting versions fail deterministic task assertions", async () => {
  const f = await fixture();
  try {
    const source =
      process.env.PI_CAMPAIGN_TEST_RLM ??
      new URL("../../../pi-ipython-rlm", import.meta.url).pathname;
    const before = await git(source, "status", "--porcelain");
    const reports = (await bootstrap(f.store, source)) as { results: { passed: boolean }[] }[];
    expect(await git(source, "status", "--porcelain")).toBe(before);
    expect(reports).toHaveLength(3);
    for (const report of reports)
      expect(report.results.map((value) => value.passed)).toEqual([false, true]);
    expect(f.store.cases().map((value) => value.role)).toEqual([
      "training",
      "validation",
      "heldOut",
    ]);
  } finally {
    await f.close();
  }
});
