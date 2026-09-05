import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

export async function loadRlm(
  cwd: string,
  agentDir: string,
  packagePath?: string,
  settingsManager = SettingsManager.create(cwd, agentDir),
): Promise<{ path: string; factory: ExtensionFactory }> {
  let path = packagePath ? join(packagePath, "extensions", "rlm.ts") : undefined;
  if (!path) {
    const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    const resources = await packages.resolve(async () => "skip");
    for (const resource of resources.extensions) {
      if (!resource.enabled || !resource.path.endsWith("/extensions/rlm.ts")) continue;
      const manifest = JSON.parse(
        await readFile(join(dirname(resource.path), "..", "package.json"), "utf8"),
      ) as { name: string };
      if (manifest.name === "pi-ipython-rlm") {
        path = resource.path;
        break;
      }
    }
  }
  if (!path)
    throw new Error(
      "pi-ipython-rlm is required. Install it with pi install /absolute/path/to/pi-ipython-rlm or supply --rlm /absolute/path/to/pi-ipython-rlm.",
    );
  // Pi 0.84.4's extension loader aliases pi-ai to compat using a prefix alias,
  // which corrupts pi-ai/api/* imports in the installed RLM package. Load its
  // unchanged factory with normal package resolution, then use Pi's public
  // inline-extension interface. No kernel or child runtime is copied here.
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
  const factory = await jiti.import<ExtensionFactory>(path, { default: true });
  if (typeof factory !== "function")
    throw new Error("Installed pi-ipython-rlm has no extension factory");
  return { path, factory };
}
