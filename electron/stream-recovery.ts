export type ReconciledText = {
  reset: boolean;
  delta: string;
};

/**
 * Reconciles a restarted model stream with text that is already visible.
 * Replayed prefix text is suppressed; a genuinely different retry resets once.
 */
export class RetryTextReconciler {
  private visible = "";
  private attempt = "";

  beginAttempt() {
    this.attempt = "";
  }

  push(delta: string): ReconciledText {
    if (!delta) return { reset: false, delta: "" };
    this.attempt += delta;

    if (this.visible.startsWith(this.attempt))
      return { reset: false, delta: "" };

    if (this.attempt.startsWith(this.visible)) {
      const suffix = this.attempt.slice(this.visible.length);
      this.visible = this.attempt;
      return { reset: false, delta: suffix };
    }

    this.visible = this.attempt;
    return { reset: true, delta: this.attempt };
  }
}
