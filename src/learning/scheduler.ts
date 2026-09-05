import type { CampaignControl } from "../campaign/control.js";

export class IdleLearning {
  private active: { controller: AbortController; promise: Promise<void> } | undefined;
  private unsubscribe: () => void;
  private closed = false;
  constructor(
    readonly control: CampaignControl,
    readonly experiment: (signal: AbortSignal) => Promise<void>,
    readonly report: (error: unknown) => void,
    readonly settled: () => boolean = () => true,
  ) {
    this.unsubscribe = control.subscribe(() => this.update());
  }
  update(): void {
    if (this.closed) return;
    const idle = this.control.campaign.status === "completed";
    if (!idle) {
      this.active?.controller.abort(new Error("Live work resumed"));
      return;
    }
    if (!this.settled()) return;
    if (this.active) return;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.experiment(controller.signal))
      .catch(this.report)
      .finally(() => {
        this.active = undefined;
      });
    this.active = { controller, promise };
  }
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe();
    this.active?.controller.abort(new Error("Campaign process exited"));
    await this.active?.promise;
  }
}
