import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CampaignControl } from "../campaign/control.js";

export class Continuation {
  private scheduled: ReturnType<typeof setImmediate> | undefined;
  private unsubscribe: () => void;
  private closed = false;
  constructor(
    readonly session: AgentSession,
    readonly control: CampaignControl,
    readonly pendingInput: () => boolean,
  ) {
    const previous = session.agent.shouldStopAfterTurn;
    session.agent.shouldStopAfterTurn = async (context, signal) =>
      control.campaign.status !== "active" || ((await previous?.(context, signal)) ?? false);
    this.unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_settled") this.schedule();
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        ["error", "aborted"].includes(event.message.stopReason) &&
        control.campaign.status === "active"
      )
        control.stop("failed", event.message.errorMessage ?? event.message.stopReason);
    });
  }
  schedule(): void {
    if (this.closed || this.scheduled || this.control.campaign.status !== "active") return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      if (
        this.closed ||
        this.control.campaign.status !== "active" ||
        this.session.isStreaming ||
        this.session.pendingMessageCount ||
        this.pendingInput()
      )
        return;
      void this.session
        .prompt(
          "Continue pursuing the campaign goal. Inspect remaining work and current evidence; save notes and request completion only through the campaign tool.",
          { source: "extension" },
        )
        .catch((error) => this.control.stop("failed", String(error)));
    });
  }
  close(): void {
    this.closed = true;
    this.unsubscribe();
    if (this.scheduled) clearImmediate(this.scheduled);
  }
}
