# Development and acceptance

Run the required checks before finishing a change:

```sh
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

`npm run check` runs formatting, lint, TypeScript, build, Vitest with 85% coverage thresholds, and the pinned Python format/lint/tests. Tests use temporary repositories, private state directories, a fake Pi model provider, scripted stage sessions, and a fake `herdr` executable. `npm run test:e2e` runs the real DSPy Python program against real in-process Pi SDK sessions that execute real tools. Both commands are self-contained after `npm ci` and `uv sync --frozen`. No automated test calls a real model or a real Herdr.

## Historical corpus

To validate the historical corpus without models:

```sh
campaign bootstrap --repo /absolute/path/to/pi-ipython-rlm --state /absolute/private/state.sqlite
```

The harness exports and tests both each reference and its parent. It requires the reference to pass and the parent to fail. It records full commit identities, pinned dependency versions, submodule identity, and complete check output. Gather progress uses the actual extension with a deterministic fake kernel/child seam, including widget cleanup on success and failure. Benchmark checks exercise gold/context separation, parsers, scoring and profiles. Held-out checks exercise host cancellation and provider-specific tool-free child completion.

The bootstrap commits are training `de0dc02`, validation `d8d03d9`, and held-out `91861ba`, each starting from its parent. The held-out solution pins librlm `ff13f9201007369ebcde0dd5b87b0d804e492e89`. Optimization receives training/validation only. Reference tests are kept in private host artifacts; reference source is never copied into a trial's Git history.

Real-model campaign, GEPA, and held-out acceptance runs are separate explicitly configured evaluations. Use `runTrial` from the learning export for a held-out case, supplying an abort deadline, model-call allowance hook, and private artifact directory. Enable automatic GEPA only with a launch allowance. Deterministic integration success does not claim a measured improvement on real models.

The replacement source snapshot is stored outside the repository so packaging and discovery cannot load the old engine. Do not restore obsolete APIs or release jobs into the new implementation.
