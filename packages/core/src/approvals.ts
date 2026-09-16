export type ApprovalDecision = "approve" | "deny";

interface ApprovalTicket {
  resolve: (decision: ApprovalDecision) => void;
}

export class ApprovalBroker {
  private pending = new Map<string, ApprovalTicket>();

  request(
    requestId: string,
    timeoutMs = 5 * 60_000,
  ): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve("deny");
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: (decision) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          resolve(decision);
        },
      });
    });
  }

  resolve(requestId: string, decision: ApprovalDecision): boolean {
    const ticket = this.pending.get(requestId);
    if (!ticket) {
      return false;
    }
    ticket.resolve(decision);
    return true;
  }

  cancelAll(): void {
    for (const ticket of this.pending.values()) {
      ticket.resolve("deny");
    }
  }
}
