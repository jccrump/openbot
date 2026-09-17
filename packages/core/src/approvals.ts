import type {
  ApprovalDecision as AuditDecision,
  ApprovalRecord,
  ApprovalTier,
} from "@openbot/protocol";
import type { Store } from "./store";

export type ApprovalDecision = "approve" | "deny";

export interface ApprovalRequestInput {
  requestId: string;
  runId?: string | null;
  threadId?: string | null;
  botId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  tool: string;
  arguments: string;
  tier: ApprovalTier;
  reason: string;
}

interface ApprovalTicket {
  settle: (
    decision: ApprovalDecision,
    decidedBy: "user" | "timeout" | "abort",
  ) => void;
}

export interface ApprovalBrokerOptions {
  store?: Store;
  onSettled?: (record: ApprovalRecord) => void;
}

export class ApprovalBroker {
  private pending = new Map<string, ApprovalTicket>();
  private onSettled?: (record: ApprovalRecord) => void;

  constructor(private readonly options: ApprovalBrokerOptions = {}) {
    this.onSettled = options.onSettled;
  }

  setOnSettled(callback: (record: ApprovalRecord) => void): void {
    this.onSettled = callback;
  }

  request(
    input: ApprovalRequestInput,
    timeoutMs = 5 * 60_000,
  ): Promise<ApprovalDecision> {
    this.options.store?.createApproval(input);
    return new Promise((resolve) => {
      const settle = (
        decision: ApprovalDecision,
        decidedBy: "user" | "timeout" | "abort",
      ) => {
        if (!this.pending.has(input.requestId)) {
          return;
        }
        this.pending.delete(input.requestId);
        if (timer) {
          clearTimeout(timer);
        }
        // The run sees a denial; the audit trail records why.
        const recorded: AuditDecision =
          decision === "approve"
            ? "approve"
            : decidedBy === "timeout"
              ? "timeout"
              : decidedBy === "abort"
                ? "abort"
                : "deny";
        const record = this.options.store?.resolveApproval(
          input.requestId,
          recorded,
          decidedBy,
        );
        if (record) {
          this.onSettled?.(record);
        }
        resolve(decision);
      };
      const timer =
        timeoutMs > 0
          ? setTimeout(() => settle("deny", "timeout"), timeoutMs)
          : null;
      this.pending.set(input.requestId, { settle });
    });
  }

  resolve(requestId: string, decision: ApprovalDecision): boolean {
    const ticket = this.pending.get(requestId);
    if (!ticket) {
      return false;
    }
    ticket.settle(decision, "user");
    return true;
  }

  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.pending.get(requestId)?.settle("deny", "abort");
    }
  }
}
