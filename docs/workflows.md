# Continuous campaigns

A campaign pursues one goal in one repository. Repository paths are resolved to the real Git root before selecting an approved candidate, so an absolute subdirectory or symlink selects the same repository policy. Run `campaign start --repo /absolute/path --goal 'Concrete goal' [--base ref] [--config file] [--rlm /absolute/package/path]`. Pi opens in a detached dedicated worktree from the resolved committed base. The original checkout's staged, unstaged, and untracked source is preserved. `campaign status` reports metadata and whether any completion evidence still matches the working tree. `--state /absolute/file.sqlite` selects separate private state.

## Scope, instructions, and completion

By default edit and test authority are true; commit, push, pullRequest, merge, release, and deploy are false. The designated worktree is the edit scope. Unrelated repositories and the original checkout are outside edit scope. Instructions and authority are supplied independently of compacted history on every decision. The plan stage reads applicable repository instructions and records the complete plan, concrete criteria, and verification commands in one `campaign plan` call before coding actions are allowed. When acceptance was supplied at launch, the plan call must omit acceptance rather than replace it. No routine human approval is required to proceed within the recorded scope. Consequential ambiguity requires a concrete blocker and user steering. The recorded plan and acceptance cannot subsequently be replaced or weakened by learned instructions.

A launch configuration can record the full contract before startup. Replace these placeholder facts with the user's task and repository requirements:

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

Use `--base main` (or another explicitly authorized ref) to select the base; otherwise committed `HEAD` is used. A repository path does not grant remote authority. Shell and IPython tools execute local code under the user's OS account, as in Pi; campaign scope is an agent instruction contract, not an OS security sandbox.

The `campaign` tool supports `notes`, `plan`, `blocker`, and `review`. Notes append durable working memory. `review` runs every recorded command through the host with complete output retained in files. The DSPy review stage receives the goal, plan, constraints, criteria, full diff including untracked files, and complete command output in a separate, tool-free context, without the author's conversation. It returns completeness, correctness, maintainability, and concrete findings. Failed checks still reach that review, then return to fix. When checks pass, a separate fixed evaluator assesses the same evidence without the learned review's verdict, prompts, or examples. Both reviews must pass; GEPA cannot weaken the evaluator. Missing checks, failed commands, malformed/unavailable review, and changes during checks or either review prevent success. Evidence includes a SHA-256 working-tree fingerprint; subsequent source changes invalidate it. Only the host can declare completion. Human candidate approval is absent from the tool schema.

Fingerprinting covers tracked files (including deletion, mode, symlink target) and nonignored untracked files. Generated ignored files are not source evidence. Submodule commit identities and dirty source are included. Keep generated check artifacts ignored and task source tracked or nonignored. Check commands that modify source require another verification pass on the final tree.

## Decisions, conversation, and RLM

One persistent Python worker contains a fixed `CampaignProgram` with four named `dspy.Predict` stages: `plan`, `implement`, `review`, and `fix`. Plan, implement, and fix consume inherited instructions, the campaign brief, current Pi conversation context, and actual tool schemas, and return a typed assistant action and tool-call list. Review returns a typed review from separate evidence-only context. Each stage has its own learned instructions and demonstrations. The host validates the entire tool-call list against Pi's registered tools before returning it to Pi and assigns unique execution IDs. Invalid output becomes an explicit stream error; it cannot silently fall back to normal Pi reasoning. Python owns no second tool-execution loop and loads no candidate Python code.

### Fixed shipping workflow

```text
plan -> implement -> review -> complete (both reviews and checks pass)
                       |
                       v
                      fix -> review -> ...
```

### Fixed stage skills

Planning uses **Ponytail (full)** to understand the actual flow, reuse existing solutions, and select the simplest complete plan. Implementation executes that recorded plan. Code review uses **Thermo-Nuclear Code Quality Review** to challenge structural complexity, unnecessary abstractions, branching, type and ownership problems, and unjustified file growth, while still checking completeness and correctness. Fix uses **Ponytail (full)** again: verify findings against the code and callers, fix supported root causes, and prefer deleting complexity over blindly implementing suggested abstractions. Record evidence for rejected or already-resolved findings in campaign notes, then request another whole-change review.

The complete skill snapshots ship in `prompts/ponytail.md` and `prompts/thermo-nuclear-code-quality-review.md`. No user-local skill installation or runtime skill discovery is required. The host supplies the applicable skill on every stage decision, including clean-context review, compaction recovery, resumed work, and evaluation trials. Skill persistence and output-style directions are stage-scoped; campaign authority, inherited constraints, inspection-only planning, tool-free review, and typed outputs take precedence.

Stage skill selection and text are fixed policy, outside GEPA's editable instructions and demonstrations, and included in the candidate's program digest. These are prompt requirements, not an OS security sandbox or a guarantee of model compliance. The independent acceptance evaluator remains unchanged and does not receive the learned review's prompts or verdict. An older candidate with a different fixed-program identity fails explicitly; start a fresh campaign with `--state /absolute/path/to/fresh-directory/state.sqlite` rather than reinterpreting old state. Existing state and worktrees are preserved.

Stage transitions and completion are host-controlled, not prompt suggestions. Planning permits only inspection tools (`read`, `grep`, `find`, `ls`) and campaign memory/control calls. Even preconfigured acceptance does not permit source edits before the plan is recorded. Implement and fix execute coding tools within the campaign's authority. Review covers the whole planned change, not individual files. Its findings, check results, and artifact paths are included in every subsequent fix brief. There is no arbitrary fix-pass cap; the agent must report a concrete blocker when it cannot make progress, and the user can pause or abort. Stage and plan survive compaction and process restart. No generic workflow registry or configurable graph is involved.

The dispatcher is installed on the public `Agent.streamFunction` interface through the SDK runtime factory. Root contexts always contain the campaign tool. In pinned Pi 0.84.4, compaction and branch summaries have no tools and use the original Pi stream. RLM children use the installed extension's focused, tool-free model runtime. They never enter the campaign policy. Model usage and allowance admission cover root decisions, summaries, independent reviews, and RLM children through the session's model runtime.

Pi 0.84.4's loader applies a prefix alias for `pi-ai/compat` that breaks RLM's `pi-ai/api/*` imports. The launcher loads the unchanged installed RLM factory with normal package resolution and registers it through Pi's public inline-extension interface. It does not copy or fork the RLM kernel or child execution code.

The Pi session and IPython kernel survive work-item boundaries. An ordinary assistant response or `rlm.final` completes only that turn or scratchpad operation. After Pi settles, the host schedules at most one continuation if the campaign remains active and no queued or edited user input is pending. Conversational steering uses Pi's normal queues. A blocker, pause, cancellation, stream failure, or verified completion stops automatic continuation. RLM analysis may fan out; coding tool execution is sequential.

The brief always includes the goal, immutable authority and constraints, recorded plan and acceptance, current stage, latest review/check evidence, saved notes, and full Pi transcript path. Inspect the JSONL transcript from IPython after compaction. Compaction retains the original session entries. `/reload` reloads extensions and stops the old RLM kernel, so a visible transcript notice reports lost Python variables; files and saved notes survive. Campaign `/new`, `/resume` to another Pi transcript, and `/fork` are blocked to retain one campaign identity. Use `campaign resume ID` for process recovery. Image input fails explicitly; version one supports text coding campaigns.

## Pause, abort, and resume

`/campaign pause` prevents subsequent actions after the current action settles. `/campaign continue` resumes in the same session. `/campaign abort` cancels active execution. Exit stops the session and Python processes, without a daemon. One live process owns a campaign worktree; process identity includes host, PID and Linux process start time to guard PID reuse.

After process loss, `campaign resume ID` claims a dead owner, reopens the worktree and full transcript, and starts fresh Python processes. Its first prompt reports lost kernel variables and directs the model to inspect current artifacts. An interrupted review resumes in fix with a notice to inspect and request a fresh review; it is never silently replayed. There is no last-operation replay, operation journal, migration reader, or parallel legacy runtime. The candidate stays pinned for the campaign lifetime.

## Learning and evaluation

GEPA improves the coding workflow after campaign completion, not the user's model hyperparameters or the currently running campaign. No learning runs without an explicit allowance and training/validation coding cases for the repository. Add these fields to a launch configuration to enable a post-campaign experiment:

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

Learning uses cases from the campaign repository only, and learned candidates carry that repository identity. An allowance bounds trial admissions and model request admissions; each trial has its own deadline. Concurrency defaults to one if omitted. In-flight calls may finish after admissions stop and their usage is retained. These limits are experiment spend controls, not truncation of user-visible output. A model-call allowance is not a dollar-price guarantee. Pi reports cost where the provider supplies it.

Cases are immutable `pi-dspy-gepa.evaluation-case.v1` objects containing `id`, `role` (`training`, `validation`, or `heldOut`), `repository`, `startingCommit`, `task`, `setup` commands, `acceptance`, and a review `rubric`. Setup is trusted host configuration. The starting tree, including pinned submodule source, is exported into a private repository with fresh history. Future commits and solution patches are absent from agent-visible Git history. The same campaign runtime runs headlessly in a dedicated worktree. The isolated repository, worktree, state, transcripts, checks, and traces are created at their final experiment artifact paths and retained in place, including failed runs. There is no teardown copy or path rewriting. Historical reference validation still uses temporary copies that are removed after its reports are saved.

Required check failures score zero. Otherwise quality is the mean of the fixed evaluator's separate completeness, correctness, and maintainability verdicts. Full credit additionally requires verified campaign completion: a learned review that rejects correct work and leaves the campaign blocked receives zero, not a perfect score. Missing or malformed review is an evaluation error with no score. Tokens, available cost, duration, and per-case outcomes are separate metrics. GEPA receives concrete check/review evidence and DSPy traces. Held-out task content and feedback are filtered out before the optimizer worker receives its inputs. The three bootstrap cases provide initial integration evidence, not broad statistical proof.

Standalone GEPA's adapter optimizes eight text fields: instruction text and a JSON list of schema-validated demonstrations for each of the four stages. Review demonstrations use the typed review output; other stages use typed actions. Python code, signatures, stage order, tools, authority, acceptance, and the independent evaluator are fixed. Candidates freeze their learned state, program digest, DSPy/GEPA/Pi versions, and content identity.

In the launcher, experiments begin only after the current campaign has completed and Pi has settled, while all other repository campaigns are completed, paused, or cancelled. Pausing an unfinished campaign does not start GEPA. The completed campaign must still have fresh evidence; its full stage traces, plan, check output, and final evidence are supplied to reflection as learning material, not as validation scores. Separate cases evaluate proposals. Do not select a validation or held-out task whose solution occurs in those source traces; known matching task descriptions are rejected. Historical replay is useful integration evidence, not proof of unseen-task generalization. The candidate/corpus/source-evidence/configuration digest prevents repeating the same experiment, including after interruption. Resumed work in another repository campaign cancels unfinished trials and retains completed results. Keep the process open for post-campaign learning; exit cancels learning and no daemon continues it.

A GEPA run finishing does not establish improvement. Compare candidates against the seed on separate validation and held-out coding tasks with the fixed checks and evaluator, retaining usage and timing as separate measures. Then explicitly approve the chosen candidate for future campaigns. The completed shipping campaign remains pinned and is never rewritten by learning.

### Evaluation lifecycle and ownership

Cancellation or a deadline leaves a trial `cancelled` with no score, even if an earlier verification passed. Existing evidence and usage remain available. Session cleanup failures leave the source and artifacts intact and produce an error result.

An active experiment rechecks its admission predicate every 250ms as well as before new model calls and trials. In the launcher this reads repository campaign status from SQLite, so live work resumed by another process cancels unfinished trials on the next observation. This is polling, not an instantaneous cross-process lock; transitions entirely between observations are not detected. No daemon or operation journal is involved.

A model runtime can belong to only one open campaign at a time. Concurrent SDK trials must supply separate runtime instances or omit `sessionOptions.modelRuntime` to use the default per-session runtime. Overlapping instrumentation fails explicitly; closing a session releases ownership and repeated cleanup is harmless.

`campaign bootstrap` also resolves repository paths to the real Git root. Custom evaluation cases must use that same canonical root for repository matching.

`/campaign learning` shows comparisons and results. `/campaign approve ID` is an explicit human command that changes the repository default for subsequent campaigns. Existing campaigns remain pinned; prior candidates remain available for selection.

The public package exports campaign contracts, state, control, verification, and workspace helpers. `pi-dspy-gepa-workflows/runtime` exports the shared Pi runtime; `pi-dspy-gepa-workflows/learning` exports trial, allowance, experiment, and scheduler helpers. Storage and campaign control are independent of Pi; runtime never imports the optimizer. The launcher composes both.
