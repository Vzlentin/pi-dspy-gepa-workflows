import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { bootstrap } from "../../src/learning/historical.js";
import { PythonWorker } from "../../src/runtime/python.js";
import { openCampaign } from "../../src/runtime/session.js";
import { fixture, call, FakeWorker, review, assistant, fakeStream } from "../helpers.js";
import { runtimeFixture } from "../runtime-fixture.js";

it("real Pi SDK, real persistent RLM kernel, deterministic DSPy actions and tool-free fake children", async () => {
  const f = await fixture();
  try {
    const options = await runtimeFixture(f.root, true);
    const worker = new FakeWorker([
      call("campaign", {
        action: "acceptance",
        acceptance: {
          criteria: ["Complete two work items with shared variables"],
          commands: ["true"],
        },
      }),
      call("ipython", { code: "counter = 41\nawait rlm.final('first work item')" }),
      call("ipython", {
        code: "assert counter == 41\ncounter += 1\nh = await rlm.spawn('Reply with fake summary')\nr = await rlm.gather([h])\nassert r[0]['text'] == 'fake summary', r\nawait rlm.final({'counter': counter, 'child': r[0]['text']})",
      }),
      call("campaign", { action: "complete" }),
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
it("real DSPy Python program obtains model access through Pi and Pi executes the chosen tool", async () => {
  const f = await fixture();
  try {
    const options = await runtimeFixture(f.root, true);
    let calls = 0;
    options.modelRuntime.registerProvider("test", {
      api: options.model.api,
      baseUrl: options.model.baseUrl,
      apiKey: "fake-key",
      models: [options.model],
      streamSimple(model, context) {
        calls++;
        expect(context.tools ?? []).toHaveLength(0);
        return fakeStream(
          assistant(
            JSON.stringify({
              action: call("campaign", {
                action: "blocker",
                text: "DSPy chose this real Pi tool call",
              }),
            }),
          ),
        )(model, context) as ReturnType<
          typeof import("@earendil-works/pi-ai").createAssistantMessageEventStream
        >;
      },
    });
    const worker = new PythonWorker(join(f.root, "dspy.log"));
    const live = await openCampaign({ ...f, ...options, worker });
    try {
      await live.runHeadless(AbortSignal.timeout(30000));
      expect(calls).toBe(1);
      expect(f.campaign.result).toBe("DSPy chose this real Pi tool call");
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
    const reports = (await bootstrap(f.store, source)) as { results: { passed: boolean }[] }[];
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
