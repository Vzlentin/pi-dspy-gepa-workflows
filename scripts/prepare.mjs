// Published packages include dist. Build local development/link installs when
// the TypeScript toolchain is present.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";

if (!existsSync(new URL("../tsconfig.build.json", import.meta.url))) process.exit(0);

try {
  const { createRequire } = await import("node:module");
  createRequire(import.meta.url).resolve("typescript");
} catch {
  console.warn(
    "pi-dspy-gepa-workflows: skipping build (typescript not installed; published builds include dist)",
  );
  process.exit(0);
}

const result = spawnSync("npm", ["run", "build"], { stdio: "inherit", shell: false });
if (result.status === 0) {
  chmodSync(new URL("../dist/launcher/cli.js", import.meta.url), 0o755);
}
process.exit(result.status ?? 1);
