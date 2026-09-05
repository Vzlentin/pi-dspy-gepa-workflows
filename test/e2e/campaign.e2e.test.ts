import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PythonWorker } from "../../src/runtime/python.js";
import { openCampaign } from "../../src/runtime/session.js";
import { fixture, call, FakeWorker, review, assistant, fakeStream } from "../helpers.js";
import { runtimeFixture } from "../runtime-fixture.js";

it("real Pi SDK executes local tools and verifies completion with a fake RLM extension", async () => {
  const f = await fixture();
  try {
    const options = await runtimeFixture(f.root);
    const worker = new FakeWorker([
      call("campaign", {
        action: "acceptance",
        acceptance: {
          criteria: ["Source is finished"],
          commands: ['test "$(cat source.txt)" = finished'],
        },
      }),
      call("write", { path: "source.txt", content: "finished" }),
      call("ipython", { code: "await rlm.final('work item')" }),
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
      expect(options.requests).toHaveLength(0);
      expect(f.campaign.evidence?.passed).toBe(true);
      expect(await readFile(join(f.campaign.worktree, "source.txt"), "utf8")).toBe("finished");
      const transcript = await readFile(f.campaign.sessionPath!, "utf8");
      expect(transcript).toContain("fake");
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
    const options = await runtimeFixture(f.root);
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
