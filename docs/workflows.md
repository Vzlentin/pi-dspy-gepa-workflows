# Continuous campaigns

A campaign pursues one goal in one repository. Repository paths are resolved to the real Git root
before selecting an approved candidate, so an absolute subdirectory or symlink selects the same
repository policy. Run `campaign start --repo /absolute/path --goal 'Concrete goal' [--base ref]
[--config file]`. The campaign works in a detached dedicated worktree from the resolved committed
base; the original checkout's staged, unstaged, and untracked source is preserved. `campaign status`
reports metadata and whether completion evidence still matches the working tree.
`--state /absolute/file.sqlite` selects separate private state.

## State and run folders

Default state is `$XDG_STATE_HOME/pi-dspy-gepa-workflows` (`~/.local/state/pi-dspy-gepa-workflows`
if the variable is unset, empty, or relative). A shared `state.sqlite` indexes campaigns and learning
records. Each campaign keeps `worktree/`, one transcript folder per stage session under
`sessions/<stage>-<n>/`, `dspy-traces.jsonl`, `python.log`, and verification artifacts under
`runs/<campaign-id>/`. Explicit resume reuses that run folder. See [state storage](SQLITE_STATE.md).

## The workflow is a DSPy module

`ShippingCampaign` (`python/pi_dspy_gepa/program.py`) has four named predictors, `plan`,
`implement`, `review`, and `fix`. `forward()` runs the host's recorded stage until the campaign
leaves `active`; the host (`NEXT` in `src/campaign/control.ts`) owns the fixed order:

```text
plan -> implement -> review -> completed (checks, evaluator, and review pass)
                       |
                       v
                      fix -> review -> ...
```

There is no registry, DSL, or configurable graph. Python never executes tools and never loads
candidate code. It talks to the host over four requests:

| Request   | Host action                                                                          |
| --------- | ------------------------------------------------------------------------------------ |
| `status`  | Current `{status, stage}`; `forward()` starts at the recorded stage.                 |
| `inputs`  | `control.begin()`: enter the recorded stage; review runs checks and the evaluator.   |
| `session` | Run one turn in a Pi session (`fresh` opens a new one) and return the final message. |
| `record`  | `control.record(output)`: validate the stage's typed output and advance to the next. |

Only the host changes campaign status. A nonempty `blocker` in a plan or report blocks the campaign;
a passing review stage completes it; pause, cancel, and failure come from the launcher.

### One fresh Pi session per stage

`PiSessionLM` is the DSPy LM. Its request (DSPy system text and demonstrations, then the formatted
stage inputs) becomes the single opening prompt of a new Pi session with `fresh: true`: new
transcript, cwd = worktree, Pi's own system prompt, no other stage's messages. Pi runs whatever
tools the stage allows; the last assistant message is parsed by `dspy.JSONAdapter`
into `Plan`, `Report`, or `Review`. If it does not parse, the same session is prompted once more
with a repair request; a second failure fails the stage.

Two adapters implement the `StageSessions` seam (`src/runtime/sessions.ts`):

- **Herdr** (`HERDR_ENV=1`): `herdr pane split` beside the launcher pane, `herdr agent start
--kind pi -- --session-dir … --tools …`, `herdr agent prompt … --wait`, then the transcript is
  read from the stage folder with Pi's `SessionManager`. Prompts are written to `prompt-<n>.md` in
  that folder and the agent is told to read them. Closing a stage closes its pane.
- **SDK** (headless, used by evaluation trials and outside Herdr): in-process `AgentSession`
  persisted to the stage folder.

Stage tools are fixed (`STAGE_TOOLS` in `src/runtime/policy.ts`): plan and review get `read`,
`grep`, `find`, `ls`; implement and fix add `bash`, `edit`, `write`, minus `edit`/`write` when the
campaign lacks edit authority.

### The brief is the only handoff

`control.brief()` is a Markdown document with the goal, workspace, authority, constraints, recorded
plan, acceptance, latest verification (checks, workflow review, independent acceptance), saved
notes, and result. Every stage receives it as the `brief` input together with
`inheritedInstructions` (fixed control rules and the stage skill). Review also receives `evidence`:
the verification error, each check's command, exit code and complete output, and the complete diff
against the base commit including untracked files. Report `summary` and `notes` are appended to the
campaign notes for later stages.

### Fixed stage skills

Planning applies **Ponytail (full)**, review applies **Thermo-Nuclear Code Quality Review**, fix
applies **Ponytail (full)**, implement executes the recorded plan. The snapshots ship in
`prompts/`. Skill text, control rules, and stage tools are fixed policy outside GEPA's reach and part
of the candidate's `programDigest`. A candidate with a different program identity fails explicitly;
start a fresh campaign with `--state /absolute/path/to/fresh-directory/state.sqlite`.

## Scope, instructions, and completion

By default edit and test authority are true; commit, push, pullRequest, merge, release, and deploy
are false. The designated worktree is the edit scope. The plan stage records the complete plan,
criteria, and verification commands; acceptance supplied at launch is immutable and the plan cannot
replace it. The recorded plan and acceptance cannot be changed afterwards.

A launch configuration can record the full contract before startup:

```json
{
  "schema": "pi-dspy-gepa.launch.v1",
  "constraints": [
    "Edit and test only the dedicated worktree for /absolute/path/to/repository; no unrelated repositories or remote actions."
  ],
  "authority": {
    "edit": true,
    "test": true,
    "commit": false,
    "push": false,
    "pullRequest": false,
    "merge": false,
    "release": false,
    "deploy": false
  },
  "acceptance": {
    "criteria": ["The requested behavior works and repository checks pass."],
    "commands": ["npm run check", "npm run test:e2e"]
  }
}
```

Entering review runs every recorded command through the host with complete output retained in
files, fingerprints the tree, and, when all checks pass, asks the fixed independent evaluator (one
tool-free model call that never sees the learned review's prompts, demonstrations, or verdict). The
review stage then reads the evidence in its own read-only session and returns completeness,
correctness, maintainability, and findings. Recording that review completes the campaign only if
checks passed, the evaluator passed, the learned review passed, and the tree is unchanged since
verification. Otherwise the workflow proceeds to fix. Failed checks still reach the review so the
fix stage gets concrete findings. Evidence carries a SHA-256 working-tree fingerprint; later source
changes invalidate it. Shell tools execute under the user's OS account; campaign scope is an
instruction contract, not a sandbox.

## Pause, abort, and resume

Ctrl-C in the launcher pauses: finished stage output is still recorded, and the next stage does
not start. `campaign resume ID` claims a dead owner (host, PID, process start time) and re-runs
`forward()`, which restarts the recorded stage in a fresh session; an interrupted review is re-run,
never replayed. A note tells the stage to inspect the worktree for partial work. There is no
operation journal or replay. The candidate stays pinned for the campaign lifetime.

## Learning and evaluation

GEPA improves the workflow after campaign completion. It runs only with an explicit allowance and
training/validation cases for the repository:

```json
{
  "schema": "pi-dspy-gepa.launch.v1",
  "allowance": {
    "maxTrials": 12,
    "trialDeadlineMs": 300000,
    "concurrency": 1,
    "maxModelCalls": 100
  },
  "casesFile": "/absolute/path/to/evaluation-cases.json"
}
```

Standalone GEPA optimizes five text fields: `plan.instructions`, `implement.instructions`,
`review.instructions`, `review.demonstrations` (a JSON list of schema-validated typed reviews with
their inputs), and `fix.instructions`. Python code, signatures, stage order, tools, authority,
acceptance, and the evaluator are fixed. Trials run the same runtime headlessly through the SDK
adapter in an isolated repository export; the isolated state, worktree, transcripts, checks, and
traces stay at their final artifact paths.

Required check failures score zero. Otherwise quality is the mean of the evaluator's completeness,
correctness, and maintainability verdicts; full credit additionally requires verified completion, so
a learned review that rejects correct work earns zero. Missing or malformed review is an evaluation
error. The completed campaign's `dspy-traces.jsonl`, plan, check output, and evidence feed
reflection, not scoring; known matching validation or held-out tasks are rejected.

Cases are immutable `pi-dspy-gepa.evaluation-case.v1` objects (`id`, `role`, `repository`,
`startingCommit`, `task`, `setup`, `acceptance`, `rubric`). `campaign bootstrap` records three
historical cases. A model runtime belongs to one open campaign at a time; concurrent SDK trials need
separate runtimes. Experiments start after the campaign completed while all other repository
campaigns are completed, paused, or cancelled; live work resumed by another process cancels
unfinished trials on the next 250ms observation. A finished GEPA run does not establish improvement:
compare on validation and held-out tasks, then `campaign approve` explicitly.

The public package exports campaign contracts, state, control, verification, and workspace helpers;
`pi-dspy-gepa-workflows/runtime` exports the session host, stage sessions, policy, evaluator, and
Python worker; `pi-dspy-gepa-workflows/learning` exports trial, allowance, and experiment helpers.
State and campaign control are independent of Pi; runtime never imports learning; the launcher
composes both.
