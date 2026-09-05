// Behavioral regression check using the real extension with a deterministic kernel/child seam.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, symlink, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "campaign-gather-check-"));
try {
  await symlink(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    join(directory, "node_modules"),
  );
  const extension = resolve("extensions/rlm.ts");
  let source = await readFile(extension, "utf8");
  source = source.replaceAll(
    /from "\.\/(.*?)"/g,
    (_match, name) => `from ${JSON.stringify(pathToFileURL(resolve("extensions", name)).href)}`,
  );
  source += "\nexport { KernelRuntime };\n";
  const output = stripTypeScriptTypes(source, { mode: "transform", sourceUrl: extension });
  const modulePath = join(directory, "extension.mjs");
  await writeFile(modulePath, output);
  const { default: register, KernelRuntime } = await import(pathToFileURL(modulePath).href);
  const updates = [];
  const widgets = [];
  let tool;
  register({
    registerTool(value) {
      tool = value;
    },
    on() {},
  });
  KernelRuntime.prototype.execute = async function (
    _id,
    _code,
    _context,
    _signal,
    progress,
    output,
  ) {
    output("line-0\nline-1\nline-11");
    progress("Waiting for 2 RLM children…");
    progress("RLM children completed: 2/2");
    const host = {
      hasFinal: false,
      usage: { totalTokens: 0, cost: { total: 0 } },
      spawned: 2,
      gathered: 2,
    };
    return {
      result: { output: "done", status: "ok", executionCount: 1, host },
      kernelReset: false,
      host,
    };
  };
  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    modelRegistry: { runtime: {} },
    ui: {
      setWidget(id, value) {
        widgets.push({ id, value });
      },
    },
  };
  await tool.execute(
    "fake",
    { code: "fake gather" },
    new AbortController().signal,
    (update) => updates.push(update),
    ctx,
  );
  const waiting = updates.find((update) => update.content[0].text.includes("Waiting for 2"));
  assert.ok(waiting.content[0].text.startsWith("Waiting for 2 RLM children…"));
  assert.ok(waiting.content[0].text.includes("line-11"));
  assert.ok(widgets.some((widget) => widget.value?.[0].includes("Waiting for 2")));
  assert.equal(widgets.at(-1).value, undefined);
  KernelRuntime.prototype.execute = async function (_id, _code, _context, _signal, progress) {
    progress("Waiting for 2 RLM children…");
    throw new Error("fake child failure");
  };
  await assert.rejects(
    tool.execute("failure", { code: "fake" }, new AbortController().signal, () => {}, ctx),
    /fake child failure/,
  );
  assert.equal(widgets.at(-1).value, undefined);
  console.log(
    "Gather progress remains visible above output; widgets clear on success and failure.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
