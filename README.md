# Pi DSPy/GEPA campaigns

Coding campaigns declared as one DSPy module. `ShippingCampaign.forward()` in
`python/pi_dspy_gepa/program.py` is the workflow: **plan → implement → review → fix → review** until
the host accepts. Every stage is one fresh Pi session: Pi runs its own tools in the campaign
worktree, and the final assistant message is the LM response DSPy parses into that stage's typed
output. The TypeScript host owns state, checks, the independent evaluator, authority, and completion.
After verified completion, explicitly budgeted GEPA experiments can improve stage instructions and
review demonstrations for future campaigns. Stage order, tools, authority, acceptance checks, and
the evaluator stay fixed. Candidate promotion is a human command.

This package is alpha. It replaces the previous per-action dispatcher, RLM integration, and
interactive Pi controls in place.

## Setup

Use Node 22.19 or newer, Git, uv, and Pi 0.85.0 (for Herdr panes, `pi` on `PATH`).

```sh
npm ci
uv sync --frozen
npm link
campaign start --repo /absolute/path/to/repository --goal 'Implement the requested change'
```

`npm link` builds the checkout and installs `campaign` on your PATH. Rebuild with `npm run build`
after source changes; normal campaign starts need no build.

```sh
campaign start --repo /absolute/path/to/repository --goal 'Implement the requested change' [--base ref] [--config file]
campaign start --repo /absolute/path/to/repository --base main --goal ./campaign.md
campaign resume CAMPAIGN_ID
campaign status
campaign learning
campaign approve CANDIDATE_ID --repo /absolute/path/to/repository
```

`--goal` accepts literal text or an existing UTF-8 file path, resolved from the current directory.
Use an absolute path or `./` / `../` prefix to require a file; a missing explicit path is an error.
The complete file contents are saved in campaign state, so resume does not need the original file.

Inside Herdr (`HERDR_ENV=1`), each stage starts a visible `pi` agent in a new pane beside the
launcher; you can watch and steer the live session. Elsewhere, stages run headlessly through the Pi
SDK pinned with this package (0.85.0). Ctrl-C pauses after the current stage; resume is explicit.

The default is verified local changes in a dedicated worktree based on committed `HEAD`. Commits,
pushes, pull requests, merges, releases, and deployments require explicit authority in a launch
configuration.

See [campaign behavior and configuration](docs/workflows.md), [state storage](docs/SQLITE_STATE.md),
and [development and evaluation](docs/development.md).
