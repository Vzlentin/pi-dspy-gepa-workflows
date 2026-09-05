import { readFile, writeFile, mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const directory = await mkdtemp(join(tmpdir(), "campaign-node-check-"));
try {
  await symlink(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    join(directory, "node_modules"),
  );
  const source = (await readFile(process.argv[2], "utf8")).replaceAll(
    /from "\.\.\/(.*?)"/g,
    (_match, name) => `from ${JSON.stringify(pathToFileURL(resolve(name)).href)}`,
  );
  const file = join(directory, "check.mjs");
  await writeFile(file, source);
  await import(pathToFileURL(file).href);
} finally {
  await rm(directory, { recursive: true, force: true });
}
