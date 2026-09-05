# Pi DSPy/GEPA campaigns

Continuous coding campaigns in Pi's existing terminal UI. A fixed DSPy workflow follows **plan → implement → review → fix → review**, with Pi executing tools and owning the transcript. After verified completion, explicitly budgeted GEPA experiments can improve each stage's instructions and demonstrations for future campaigns. Stage order, authority, acceptance checks, and the independent evaluator stay fixed. Candidate promotion is a human command.

This package is alpha. It replaces the previous workflow engine, controllers, standalone viewers, and workflow catalog in place.

## Setup

Use Node 22.18 or newer, Git, and uv. Install and configure Pi 0.84.4 and the existing `pi-ipython-rlm` package. Its IPython environment must be available; the RLM package provides its own provisioning instructions.

```sh
npm ci
uv sync --frozen
npm run build
node dist/launcher/cli.js start --repo /absolute/path/to/repository --goal 'Implement the requested change' --rlm /absolute/path/to/pi-ipython-rlm
```

The installed executable is `campaign`. Omit `--rlm` when Pi's configured packages already identify the installed RLM extension.

```sh
campaign start --repo /absolute/path/to/repository --goal 'Implement the requested change'
campaign resume CAMPAIGN_ID
campaign status
```

The default is verified local changes in a dedicated worktree based on committed `HEAD`. Uncommitted source changes are not copied. Commits, pushes, pull requests, merges, releases, and deployments require explicit authority in a launch configuration. Exit stops execution; resume is explicit.

Inside Pi, steer conversationally or use `/campaign status`, `/campaign pause`, `/campaign continue`, `/campaign abort`, `/campaign learning`, and `/campaign approve CANDIDATE_ID`. The agent's campaign tool cannot approve candidates.

See [campaign behavior and configuration](docs/workflows.md), [state storage](docs/SQLITE_STATE.md), and [development and evaluation](docs/development.md).
