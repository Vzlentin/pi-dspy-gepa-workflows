import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { assistant, fakeStream, model } from "./helpers.js";

/** A real Pi model runtime whose only provider answers from `respond`. */
export async function runtimeFixture(
  root: string,
  respond: (context: Context) => AssistantMessage = () => assistant("fake summary"),
) {
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
      return fakeStream(respond(context));
    },
  });
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: model.provider,
    defaultModel: model.id,
    compaction: { enabled: false, keepRecentTokens: 10, reserveTokens: 128 },
    retry: { enabled: false },
  });
  return {
    agentDir,
    modelRuntime,
    model,
    settingsManager,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    },
    requests,
  };
}
