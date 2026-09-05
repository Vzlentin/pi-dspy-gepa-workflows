import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CampaignControl } from "../campaign/control.js";

export interface CampaignCommands {
  abort(): Promise<void>;
  continue(): Promise<void>;
  learning(): Promise<string>;
  approve(id: string): Promise<string>;
  shutdown(): Promise<void>;
}
export function campaignExtension(
  control: CampaignControl,
  commands: CampaignCommands,
  editor: { pending: () => boolean },
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "campaign",
      label: "Campaign",
      description:
        "Save notes, record the complete plan and immutable acceptance before editing, report a blocker, or request review of the whole change. Failed review enters fix; passing review and independent acceptance complete the campaign. Human candidate approval is unavailable to agents.",
      parameters: Type.Object(
        {
          action: Type.Union([
            Type.Literal("notes"),
            Type.Literal("plan"),
            Type.Literal("blocker"),
            Type.Literal("review"),
          ]),
          text: Type.Optional(Type.String()),
          acceptance: Type.Optional(
            Type.Object({
              criteria: Type.Array(Type.String()),
              commands: Type.Array(Type.String()),
            }),
          ),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const result = await control.action(params, signal ?? new AbortController().signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
          terminate: control.campaign.status !== "active",
        };
      },
    });
    pi.registerCommand("campaign", {
      description: "status | pause | continue | abort | learning | approve <candidate-id>",
      async handler(args, ctx) {
        const [command = "status", id] = (args.trim() || "status").split(/\s+/);
        let message: string;
        switch (command) {
          case "status":
            message = JSON.stringify(control.campaign, null, 2);
            break;
          case "pause":
            control.pause();
            message = "Pausing after the current action settles.";
            break;
          case "continue":
            await commands.continue();
            message = "Campaign continuing in this session.";
            break;
          case "abort":
            await commands.abort();
            message = "Campaign aborted.";
            break;
          case "learning":
            message = await commands.learning();
            break;
          case "approve":
            if (!id) throw new Error("Supply a candidate ID");
            message = await commands.approve(id);
            break;
          default:
            throw new Error(`Unknown /campaign command: ${command}`);
        }
        ctx.ui.notify(message, "info");
      },
    });
    pi.on("session_start", async (event, ctx) => {
      editor.pending = () => ctx.hasUI && ctx.ui.getEditorText().trim().length > 0;
      if (event.reason === "reload") control.changed();
    });
    pi.on("session_shutdown", async (event) => {
      if (event.reason === "quit") {
        await commands.shutdown();
        return;
      }
      if (event.reason !== "reload") return;
      const notice =
        "Pi resources were reloaded. The RLM kernel was stopped; Python variables were lost. Files, saved campaign notes, and the full transcript survive. Inspect current artifacts before continuing.";
      control.campaign.notes.push(notice);
      control.changed();
      pi.sendMessage({ customType: "campaign-kernel-reset", content: notice, display: true });
    });
    pi.on("input", async (event) => {
      if (event.images?.length) {
        control.stop("failed", "Image inputs are unsupported in text campaigns");
        throw new Error(control.campaign.result!);
      }
      return { action: "continue" };
    });
    // Campaign identity includes one transcript. Ordinary /reload remains supported.
    pi.on("session_before_switch", async () => ({ cancel: true }));
    pi.on("session_before_fork", async () => ({ cancel: true }));
    pi.on("tool_call", async (event) => {
      if (control.campaign.status !== "active")
        return { block: true, reason: `Campaign is ${control.campaign.status}` };
      if (["read", "grep", "find", "ls", "campaign"].includes(event.toolName)) return;
      if (!["implement", "fix"].includes(control.campaign.stage))
        return {
          block: true,
          reason:
            "Record the complete plan and acceptance before executing coding actions; only implement and fix may execute code",
        };
      if (!control.campaign.authority.edit && ["edit", "write"].includes(event.toolName))
        return { block: true, reason: "No edit authority" };
      return;
    });
  };
}
