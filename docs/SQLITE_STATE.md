# Campaign SQLite state

State lives at `~/.pi/agent/pi-dspy-gepa-workflows/state.sqlite`, the package's existing private location. New directories use mode 0700 and the database uses 0600. SQLite uses WAL, foreign keys, and an immediate transaction for ownership claims.

The database retains schema name `pi-dspy-gepa-workflows-state` and schema version `1`. Startup checks the exact table definitions and metadata through a read-only connection before opening an existing database for writing. Incompatible workflow state is left intact and rejected with a reset instruction: back up and move `state.sqlite` and its `-wal`/`-shm` companions, then restart. No migrations, compatibility readers, aliases, dual writes, or automatic deletion are provided.

Tables:

- `metadata`: the exact campaign schema identifier.
- `campaigns`: unique ID and worktree plus camelCase campaign metadata. Repository, base, goal, authority, constraints, candidate, recorded plan, and recorded acceptance are immutable. Status, workflow stage (`plan`, `implement`, `review`, `fix`), notes, session path, result and evidence can change. The table requires explicit stage and plan fields; the previous single-predictor alpha state fails the read-only shape check and must be reset explicitly.
- `owners`: one live process token per worktree. A dead token is replaced only during an explicit claim. Release is conditional on the matching token.
- `candidates`: content-addressed immutable stage-specific instructions and validated demonstrations, fixed-program identity, and runtime provenance. Exactly four stages are present; review examples carry typed reviews rather than tool actions.
- `profiles`: a repository's human-approved default candidate.
- `cases`: immutable evaluation cases. Changed content requires a new case ID.
- `experiments`: candidate/corpus/source-evidence/configuration identities, preventing repeated post-campaign admission.
- `trials`: per-case quality, status, usage, timing and artifact references.

All persisted structured records use camelCase fields and versioned `schema` identifiers. Existing alpha version identifiers remain `v1`; the superseded workflow implementation has been removed.

Pi's JSONL session file is the conversation authority. The database stores its path, not a replayable copy of each operation. Complete DSPy traces, Python diagnostics, verification logs, review evidence and evaluation source artifacts live in private files. Each evidence object records its content fingerprint and output locations. `campaign status` computes freshness from current source.

Trial state and its isolated Git repository are created directly under the trial's private artifact directory. Their worktree, transcript, and evidence paths remain valid after shutdown; teardown never copies the database or rewrites serialized paths. Failed trials retain the same files for inspection.

There is no per-operation replay or automatic daemon recovery. Explicit resume reuses the transcript and working tree with fresh Python processes. A claimed live owner prevents concurrent writers. The SQLite store imports no Pi, runtime, or learning modules.
