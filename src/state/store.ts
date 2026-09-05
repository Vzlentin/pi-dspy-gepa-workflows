import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  candidateId,
  CandidateSchema,
  CaseSchema,
  validate,
  type Campaign,
  type Candidate,
  type EvaluationCase,
  type Trial,
} from "./contracts.js";

const SHAPE = `
CREATE TABLE metadata (schema TEXT NOT NULL, schemaVersion INTEGER NOT NULL);
INSERT INTO metadata VALUES ('pi-dspy-gepa-workflows-state',1);
CREATE TABLE campaigns (id TEXT PRIMARY KEY, worktree TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
CREATE TABLE owners (worktree TEXT PRIMARY KEY, token TEXT NOT NULL);
CREATE TABLE candidates (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE profiles (repository TEXT PRIMARY KEY, candidateId TEXT NOT NULL REFERENCES candidates(id));
CREATE TABLE cases (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE experiments (id TEXT PRIMARY KEY, repository TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE trials (id TEXT PRIMARY KEY, experimentId TEXT NOT NULL REFERENCES experiments(id), data TEXT NOT NULL);
`;
export const RESET_INSTRUCTION =
  "Incompatible alpha state. Back up and move state.sqlite and its -wal/-shm files, then restart campaign to create a fresh database. Existing state was not changed.";
export function statePath(): string {
  return join(homedir(), ".pi", "agent", "pi-dspy-gepa-workflows", "state.sqlite");
}
export class Store {
  readonly db: Database.Database;
  readonly root: string;
  constructor(readonly filePath = statePath()) {
    this.root = dirname(filePath);
    const exists = existsSync(filePath);
    if (exists) {
      const probe = new Database(filePath, { readonly: true, fileMustExist: true });
      try {
        const expected = new Database(":memory:");
        try {
          expected.exec(SHAPE);
          const sql =
            "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
          if (
            JSON.stringify(probe.prepare(sql).all()) !==
              JSON.stringify(expected.prepare(sql).all()) ||
            JSON.stringify(probe.prepare("SELECT * FROM metadata").all()) !==
              JSON.stringify(expected.prepare("SELECT * FROM metadata").all())
          )
            throw new Error(RESET_INSTRUCTION);
        } finally {
          expected.close();
        }
      } catch {
        throw new Error(RESET_INSTRUCTION);
      } finally {
        probe.close();
      }
    }
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.db = new Database(filePath);
    if (!exists) this.db.exec(SHAPE);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    chmodSync(filePath, 0o600);
  }
  close(): void {
    this.db.close();
  }
  saveCampaign(campaign: Campaign): void {
    const old = this.getCampaign(campaign.id);
    if (
      old &&
      [
        "repository",
        "worktree",
        "baseCommit",
        "candidateId",
        "goal",
        "constraints",
        "authority",
        "acceptance",
      ].some((key) => {
        if (key === "acceptance" && old.acceptance === null) return false;
        return (
          JSON.stringify(old[key as keyof Campaign]) !==
          JSON.stringify(campaign[key as keyof Campaign])
        );
      })
    )
      throw new Error("Campaign contract is immutable after recording");
    this.db
      .prepare(
        "INSERT INTO campaigns VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(campaign.id, campaign.worktree, JSON.stringify(campaign));
  }
  getCampaign(id: string): Campaign | undefined {
    return this.get<Campaign>("campaigns", id);
  }
  campaigns(): Campaign[] {
    return this.all<Campaign>("campaigns");
  }
  addCandidate(candidate: Candidate): string {
    const id = candidateId(candidate);
    this.db
      .prepare("INSERT OR IGNORE INTO candidates VALUES (?,?)")
      .run(id, JSON.stringify(candidate));
    return id;
  }
  candidate(id: string): Candidate {
    const value = validate(CandidateSchema, this.get("candidates", id));
    if (candidateId(value) !== id) throw new Error("Candidate content digest mismatch");
    return value;
  }
  defaultCandidate(repository: string): string | undefined {
    return (
      this.db.prepare("SELECT candidateId FROM profiles WHERE repository=?").get(repository) as
        | { candidateId: string }
        | undefined
    )?.candidateId;
  }
  // Only the launcher exposes this operation, through a human command.
  approve(repository: string, id: string): void {
    const candidate = this.candidate(id);
    if (candidate.repository !== null && candidate.repository !== repository)
      throw new Error("Learned candidates belong to one repository");
    this.db
      .prepare(
        "INSERT INTO profiles VALUES (?,?) ON CONFLICT(repository) DO UPDATE SET candidateId=excluded.candidateId",
      )
      .run(repository, id);
  }
  claim(worktree: string, token: string, alive: (token: string) => boolean): void {
    this.db
      .transaction(() => {
        const owner = this.db.prepare("SELECT token FROM owners WHERE worktree=?").get(worktree) as
          | { token: string }
          | undefined;
        if (owner && alive(owner.token))
          throw new Error("Campaign worktree already has a live owner");
        this.db
          .prepare(
            "INSERT INTO owners VALUES (?,?) ON CONFLICT(worktree) DO UPDATE SET token=excluded.token",
          )
          .run(worktree, token);
      })
      .immediate();
  }
  release(worktree: string, token: string): void {
    this.db.prepare("DELETE FROM owners WHERE worktree=? AND token=?").run(worktree, token);
  }
  addCase(value: EvaluationCase): void {
    validate(CaseSchema, value);
    const previous = this.get("cases", value.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value))
      throw new Error("Evaluation cases are immutable; use a new case ID");
    this.db
      .prepare("INSERT OR IGNORE INTO cases VALUES (?,?)")
      .run(value.id, JSON.stringify(value));
  }
  cases(): EvaluationCase[] {
    return this.all("cases");
  }
  startExperiment(id: string, repository: string, config: unknown): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO experiments VALUES (?,?,?)")
        .run(id, repository, JSON.stringify(config)).changes === 1
    );
  }
  finishExperiment(id: string, result: unknown): void {
    const experiment = this.get<Record<string, unknown>>("experiments", id);
    if (!experiment) throw new Error("Unknown experiment");
    this.db
      .prepare("UPDATE experiments SET data=? WHERE id=?")
      .run(JSON.stringify({ ...experiment, result }), id);
  }
  experiments(): unknown[] {
    return this.all("experiments");
  }
  addTrial(trial: Trial): void {
    this.db
      .prepare("INSERT INTO trials VALUES (?,?,?)")
      .run(trial.id, trial.experimentId, JSON.stringify(trial));
  }
  trials(): Trial[] {
    return this.all("trials");
  }
  private get<T>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  private all<T>(table: string): T[] {
    return (
      this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[]
    ).map((row) => JSON.parse(row.data) as T);
  }
}
