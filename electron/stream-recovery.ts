export type ReconciledText = {
  reset: boolean;
  delta: string;
};

/**
 * Reconciles a restarted model stream with text that is already visible.
 * Replayed prefix text is suppressed. A divergent retry is buffered until it
 * catches up with the visible answer or completes successfully, so a short
 * retry prefix cannot make a long answer visibly jump backwards.
 */
export class RetryTextReconciler {
  private visible = "";
  private attempt = "";
  private retrying = false;
  private diverged = false;

  beginAttempt() {
    this.attempt = "";
    this.retrying = this.visible.length > 0;
    this.diverged = false;
  }

  push(delta: string): ReconciledText {
    if (!delta) return { reset: false, delta: "" };
    this.attempt += delta;

    if (!this.retrying) {
      this.visible = this.attempt;
      return { reset: false, delta };
    }

    if (this.diverged) return { reset: false, delta: "" };

    if (this.visible.startsWith(this.attempt))
      return { reset: false, delta: "" };

    if (this.attempt.startsWith(this.visible)) {
      const suffix = this.attempt.slice(this.visible.length);
      this.visible = this.attempt;
      this.retrying = false;
      return { reset: false, delta: suffix };
    }

    // The retry genuinely diverged. Keep the prior answer visible until this
    // attempt completes successfully. If the transport fails again, the next
    // attempt still reconciles against the last confirmed visible answer.
    this.diverged = true;
    return { reset: false, delta: "" };
  }

  completeAttempt(): ReconciledText {
    if (!this.retrying) return { reset: false, delta: "" };
    this.retrying = false;
    if (this.attempt === this.visible) return { reset: false, delta: "" };
    this.visible = this.attempt;
    return { reset: true, delta: this.attempt };
  }
}
