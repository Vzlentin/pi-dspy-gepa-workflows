import { AcceptanceSchema, validate, type Campaign } from "../state/contracts.js";
import type { Store } from "../state/store.js";
import { verify, evidenceCurrent, type Reviewer } from "./verification.js";

export class CampaignControl {
  private listeners = new Set<() => void>();
  constructor(
    readonly store: Store,
    readonly campaign: Campaign,
    readonly reviewer: Reviewer,
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
      case "acceptance":
        if (this.campaign.acceptance)
          throw new Error("Acceptance is already recorded and cannot be weakened");
        this.campaign.acceptance = validate(AcceptanceSchema, input.acceptance);
        this.changed();
        return this.campaign.acceptance;
      case "verify":
      case "complete": {
        this.campaign.evidence = await verify(this.campaign, this.artifacts, this.reviewer, signal);
        if (
          input.action === "complete" &&
          this.campaign.status === "active" &&
          !signal.aborted &&
          (await evidenceCurrent(this.campaign))
        ) {
          this.campaign.status = "completed";
          this.campaign.result = this.campaign.evidence.review!.findings;
        }
        this.changed();
        return this.campaign.evidence;
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
      acceptance: this.campaign.acceptance,
      notes: this.campaign.notes,
      transcriptPath: this.campaign.sessionPath,
      status: this.campaign.status,
    });
  }
}
