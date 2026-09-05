import { AcceptanceSchema, validate, type Campaign } from "../state/contracts.js";
import type { Store } from "../state/store.js";
import { verify, evidenceCurrent, type Reviewers } from "./verification.js";

export class CampaignControl {
  private listeners = new Set<() => void>();
  constructor(
    readonly store: Store,
    readonly campaign: Campaign,
    readonly reviewers: Reviewers,
    readonly artifacts: string,
  ) {}
  changed(): void {
    this.store.saveCampaign(this.campaign);
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  pause(): void {
    if (this.campaign.status === "active") {
      this.campaign.status = "paused";
      this.changed();
    }
  }
  continue(): void {
    if (this.campaign.status === "completed" || this.campaign.status === "cancelled")
      throw new Error("Completed or cancelled campaigns cannot continue");
    this.campaign.status = "active";
    this.campaign.result = null;
    this.changed();
  }
  stop(status: "cancelled" | "failed", reason: string): void {
    this.campaign.status = status;
    this.campaign.result = reason;
    this.changed();
  }
  async action(
    input: { action: string; text?: string; acceptance?: unknown },
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (this.campaign.status !== "active") throw new Error(`Campaign is ${this.campaign.status}`);
    switch (input.action) {
      case "notes":
        if (!input.text?.trim()) throw new Error("Notes must be nonempty");
        this.campaign.notes.push(input.text);
        this.changed();
        return { saved: true };
      case "blocker":
        if (!input.text?.trim()) throw new Error("A blocker needs a concrete reason");
        this.campaign.status = "blocked";
        this.campaign.result = input.text;
        this.changed();
        return { blocked: input.text };
      case "plan": {
        if (this.campaign.stage !== "plan") throw new Error("Plan is already recorded");
        if (!input.text?.trim()) throw new Error("A complete plan is required");
        if (this.campaign.acceptance && input.acceptance !== undefined)
          throw new Error("Acceptance is already recorded and cannot be weakened");
        const acceptance = this.campaign.acceptance ?? validate(AcceptanceSchema, input.acceptance);
        this.campaign.acceptance = acceptance;
        this.campaign.plan = input.text;
        this.campaign.stage = "implement";
        this.changed();
        return { stage: this.campaign.stage, plan: this.campaign.plan, acceptance };
      }
      case "review": {
        if (this.campaign.stage === "plan") throw new Error("Record the plan before review");
        this.campaign.stage = "review";
        this.campaign.evidence = null;
        this.changed();
        try {
          this.campaign.evidence = await verify(
            this.campaign,
            this.artifacts,
            this.reviewers,
            signal,
          );
          if (
            this.campaign.status === "active" &&
            !signal.aborted &&
            (await evidenceCurrent(this.campaign))
          ) {
            this.campaign.status = "completed";
            this.campaign.result = this.campaign.evidence.review!.findings;
          } else {
            this.campaign.stage = "fix";
          }
          return this.campaign.evidence;
        } catch (error) {
          this.campaign.stage = "fix";
          this.campaign.result = `Review could not finish: ${String(error)}`;
          throw error;
        } finally {
          this.changed();
        }
      }
      default:
        throw new Error(`Unknown campaign action: ${input.action}`);
    }
  }
  brief(): string {
    return JSON.stringify({
      goal: this.campaign.goal,
      repository: this.campaign.repository,
      worktree: this.campaign.worktree,
      baseCommit: this.campaign.baseCommit,
      baseRef: this.campaign.baseRef,
      authority: this.campaign.authority,
      constraints: this.campaign.constraints,
      stage: this.campaign.stage,
      plan: this.campaign.plan,
      acceptance: this.campaign.acceptance,
      evidence: this.campaign.evidence,
      notes: this.campaign.notes,
      transcriptPath: this.campaign.sessionPath,
      status: this.campaign.status,
      result: this.campaign.result,
    });
  }
}
