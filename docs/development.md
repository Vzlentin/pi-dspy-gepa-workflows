# Development and acceptance

Run the required checks before finishing a change:

```sh
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

`npm run check` runs formatting, lint, TypeScript, build, Vitest with 85% coverage thresholds, and the pinned Python format/lint/tests. Tests use temporary repositories, private state directories, fake models and deterministic DSPy responses. `npm run test:e2e` runs the real Pi SDK and real DSPy Python program with a local fake RLM extension. Both commands are self-contained after `npm ci` and `uv sync --frozen`: CI and publishing need no private repository checkout or cross-repository token. No automated test calls a real model.

## Local RLM acceptance

Run the real persistent IPython kernel and historical reference checks explicitly:

```sh
PI_CAMPAIGN_TEST_RLM=/absolute/path/to/pi-ipython-rlm npm run test:acceptance
```

The RLM checkout defaults to the sibling `../pi-ipython-rlm`. Use commit `91861ba9427605efc67d88968339181910a4ed19` with full history, initialize its pinned `librlm` submodule, and provision its documented IPython environment before running acceptance. Tests copy the extension, library and Python environment into a temporary directory. They do not modify the installed RLM package. Missing prerequisites fail the command rather than silently skipping tests. Acceptance is local and opt-in, not part of default CI or publishing; default test success does not establish real-RLM compatibility.

To validate the historical corpus without models:

```sh
campaign bootstrap --repo /absolute/path/to/pi-ipython-rlm --state /absolute/private/state.sqlite
```

The harness exports and tests both each reference and its parent. It requires the reference to pass and the parent to fail. It records full commit identities, pinned dependency versions, submodule identity, and complete check output. Gather progress uses the actual extension with a deterministic fake kernel/child seam, including widget cleanup on success and failure. Benchmark checks exercise gold/context separation, parsers, scoring and profiles. Held-out checks exercise host cancellation and provider-specific tool-free child completion.

The bootstrap commits are training `de0dc02`, validation `d8d03d9`, and held-out `91861ba`, each starting from its parent. The held-out solution pins librlm `ff13f9201007369ebcde0dd5b87b0d804e492e89`. Optimization receives training/validation only. Reference tests are kept in private host artifacts; reference source is never copied into a trial's Git history.

Real-model campaign, GEPA, and held-out acceptance runs are separate explicitly configured evaluations. Use `runTrial` from the learning export for a held-out case, supplying an abort deadline, model-call allowance hook, RLM package path and private artifact directory. Enable automatic GEPA only with a launch allowance. Deterministic integration success does not claim a measured improvement on real models.

The replacement source snapshot is stored outside the repository so packaging and discovery cannot load the old engine. Do not restore obsolete APIs or release jobs into the new implementation.
