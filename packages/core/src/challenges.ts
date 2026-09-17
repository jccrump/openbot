export type ChallengeDecision = "retry" | "skip";

interface ChallengeTicket {
  resolve: (decision: ChallengeDecision) => void;
}

export class ChallengeBroker {
  private pending = new Map<string, ChallengeTicket>();

  request(
    requestId: string,
    timeoutMs = 5 * 60_000,
  ): Promise<ChallengeDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve("skip");
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

  resolve(requestId: string, decision: ChallengeDecision): boolean {
    const ticket = this.pending.get(requestId);
    if (!ticket) {
      return false;
    }
    ticket.resolve(decision);
    return true;
  }

  cancelAll(): void {
    for (const ticket of this.pending.values()) {
      ticket.resolve("skip");
    }
  }
}
