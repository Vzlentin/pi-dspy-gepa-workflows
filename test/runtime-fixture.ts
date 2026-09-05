import { cp, mkdir, symlink, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT } from "../src/runtime/python.js";
import { assistant, fakeStream, model } from "./helpers.js";

export async function runtimeFixture(root: string, realRlm = false) {
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const requests: Context[] = [];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("test", {
    api: model.api,
    baseUrl: model.baseUrl,
    apiKey: "fake-test-key",
    models: [model],
    streamSimple: (_model, context) => {
      requests.push(context);
      return fakeStream(assistant("fake summary"))(_model, context) as ReturnType<
        typeof import("@earendil-works/pi-ai").createAssistantMessageEventStream
      >;
    },
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 10, reserveTokens: 128 },
    retry: { enabled: false },
  });
  const rlmPackage = join(root, "rlm");
  await mkdir(join(rlmPackage, "extensions"), { recursive: true });
  if (realRlm) {
    const source = process.env.PI_CAMPAIGN_TEST_RLM ?? resolve(PACKAGE_ROOT, "../pi-ipython-rlm");
    await access(join(source, "extensions", "rlm.ts"));
    await cp(join(source, "extensions"), join(rlmPackage, "extensions"), {
      recursive: true,
      filter: (path) => !path.includes(".rlm-python") && !path.includes("__pycache__"),
    });
    await cp(join(source, "librlm", "rlm"), join(rlmPackage, "librlm", "rlm"), {
      recursive: true,
      filter: (path) => !path.includes("__pycache__"),
    });
    await cp(
      join(source, "extensions", ".rlm-python"),
      join(rlmPackage, "extensions", ".rlm-python"),
      { recursive: true },
    );
  } else {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(rlmPackage, "extensions", "rlm.ts"),
      `import { Type } from "typebox"; export default function(pi) { pi.registerTool({ name: "ipython", label: "IPython fake", description: "Test scratchpad", parameters: Type.Object({ code: Type.String() }), async execute() { return { content: [{type:"text",text:"fake"}], details: {}, terminate: true }; } }); }`,
    );
  }
  await symlink(join(PACKAGE_ROOT, "node_modules"), join(rlmPackage, "node_modules"));
  return {
    agentDir,
    modelRuntime,
    model,
    settingsManager,
    rlmPackage,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    },
    requests,
  };
}
