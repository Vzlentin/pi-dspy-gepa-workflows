# Continuous campaigns

A campaign pursues one goal in one repository. Run `campaign start --repo /absolute/path --goal 'Concrete goal' [--base ref] [--config file] [--rlm /absolute/package/path]`. Pi opens in a detached dedicated worktree from the resolved committed base. The original checkout's staged, unstaged, and untracked source is preserved. `campaign status` reports metadata and whether any completion evidence still matches the working tree. `--state /absolute/file.sqlite` selects separate private state.

## Scope, instructions, and completion

By default edit and test authority are true; commit, push, pullRequest, merge, release, and deploy are false. The designated worktree is the edit scope. Unrelated repositories and the original checkout are outside edit scope. Instructions and authority are supplied independently of compacted history on every decision. The model reads applicable repository instructions and records concrete criteria and verification commands in one `campaign` acceptance call before coding actions are allowed. Consequential ambiguity requires a concrete blocker and user steering. Criteria cannot subsequently be replaced or weakened by learned instructions.

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

The `campaign` tool supports `notes`, `acceptance`, `blocker`, `verify`, and `complete`. Notes append durable working memory. A completion request runs every recorded command through the host with complete output retained in files, then invokes an independent tool-free reviewer against the goal, constraints, criteria, full diff including untracked files, and complete command output. Completeness, correctness, and maintainability must all pass. Missing checks, failed commands, malformed/unavailable review, and changes during checks or review prevent success. Evidence includes a SHA-256 working-tree fingerprint; subsequent source changes invalidate it. Review does not execute tools. Human candidate approval is absent from the tool schema.

Fingerprinting covers tracked files (including deletion, mode, symlink target) and nonignored untracked files. Generated ignored files are not source evidence. Submodule commit identities and dirty source are included. Keep generated check artifacts ignored and task source tracked or nonignored. Check commands that modify source require another verification pass on the final tree.

## Decisions, conversation, and RLM

One persistent Python worker contains a fixed `dspy.Module` with one `dspy.Predict` next-action signature. Inputs are inherited instructions, the campaign brief, current Pi conversation context, and actual tool schemas. Output is a typed assistant action and tool-call list. The host validates the entire list against Pi's registered tools before returning it to Pi and assigns unique execution IDs. Invalid output becomes an explicit stream error; it cannot silently fall back to normal Pi reasoning. Python owns no second execution loop and loads no candidate Python code.

The dispatcher is installed on the public `Agent.streamFunction` interface through the SDK runtime factory. Root contexts always contain the campaign tool. In pinned Pi 0.84.4, compaction and branch summaries have no tools and use the original Pi stream. RLM children use the installed extension's focused, tool-free model runtime. They never enter the campaign policy. Model usage and allowance admission cover root decisions, summaries, independent reviews, and RLM children through the session's model runtime.

Pi 0.84.4's loader applies a prefix alias for `pi-ai/compat` that breaks RLM's `pi-ai/api/*` imports. The launcher loads the unchanged installed RLM factory with normal package resolution and registers it through Pi's public inline-extension interface. It does not copy or fork the RLM kernel or child execution code.

The Pi session and IPython kernel survive work-item boundaries. An ordinary assistant response or `rlm.final` completes only that turn or scratchpad operation. After Pi settles, the host schedules at most one continuation if the campaign remains active and no queued or edited user input is pending. Conversational steering uses Pi's normal queues. A blocker, pause, cancellation, stream failure, or verified completion stops automatic continuation. RLM analysis may fan out; coding tool execution is sequential.

The brief always includes the goal, immutable authority and constraints, acceptance, saved notes, and full Pi transcript path. Inspect the JSONL transcript from IPython after compaction. Compaction retains the original session entries. `/reload` reloads extensions and stops the old RLM kernel, so a visible transcript notice reports lost Python variables; files and saved notes survive. Campaign `/new`, `/resume` to another Pi transcript, and `/fork` are blocked to retain one campaign identity. Use `campaign resume ID` for process recovery. Image input fails explicitly; version one supports text coding campaigns.

## Pause, abort, and resume

`/campaign pause` prevents subsequent actions after the current action settles. `/campaign continue` resumes in the same session. `/campaign abort` cancels active execution. Exit stops the session and Python processes, without a daemon. One live process owns a campaign worktree; process identity includes host, PID and Linux process start time to guard PID reuse.

After process loss, `campaign resume ID` claims a dead owner, reopens the worktree and full transcript, and starts fresh Python processes. Its first prompt reports lost kernel variables and directs the model to inspect current artifacts. There is no last-operation replay, operation journal, migration reader, or parallel legacy runtime. The candidate stays pinned for the campaign lifetime.

## Learning and evaluation

No learning runs without an explicit allowance. Add these fields to a launch configuration to enable an idle experiment:

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

Cases are immutable `pi-dspy-gepa.evaluation-case.v1` objects containing `id`, `role` (`training`, `validation`, or `heldOut`), `repository`, `startingCommit`, `task`, `setup` commands, `acceptance`, and a review `rubric`. Setup is trusted host configuration. The starting tree, including pinned submodule source, is exported into a temporary repository with fresh history. Future commits and solution patches are absent from agent-visible Git history. The same campaign runtime runs headlessly in a dedicated worktree within that disposable copy. Complete final source, transcripts, checks, and traces are retained as experiment artifacts after the temporary copy is removed.

Required check failures score zero. Otherwise quality is the mean of separate completeness, correctness, and maintainability verdicts. Missing or malformed review is an evaluation error with no score. Tokens, available cost, duration, and per-case outcomes are separate metrics. GEPA receives concrete check/review evidence and DSPy traces. Held-out task content and feedback are filtered out before the optimizer worker receives its inputs. The three bootstrap cases provide initial integration evidence, not broad statistical proof.

Standalone GEPA's adapter optimizes exactly two text components: instruction text and a JSON list of schema-validated demonstrations. Python code, signatures, tools, and control rules are fixed. Candidates freeze their learned state, program digest, DSPy/GEPA/Pi versions, and content identity. Experiments begin only when repository campaigns are completed or paused. Continuing live work cancels unfinished trials and retains completed results. The candidate/corpus/configuration digest prevents repeating the same idle experiment, including after interruption.

`/campaign learning` shows comparisons and results. `/campaign approve ID` is an explicit human command that changes the repository default for subsequent campaigns. Existing campaigns remain pinned; prior candidates remain available for selection.

The public package exports campaign contracts, state, control, verification, and workspace helpers. `pi-dspy-gepa-workflows/runtime` exports the shared Pi runtime; `pi-dspy-gepa-workflows/learning` exports trial, allowance, experiment, and scheduler helpers. Storage and campaign control are independent of Pi; runtime never imports the optimizer. The launcher composes both.
