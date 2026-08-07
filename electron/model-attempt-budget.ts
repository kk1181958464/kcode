export class ModelAttemptBudgetExhaustedError extends Error {
  constructor(readonly maxAttempts: number) {
    super(`本轮模型请求已达到 ${maxAttempts} 次重试预算`);
    this.name = "ModelAttemptBudgetExhaustedError";
  }
}

/** Counts real upstream HTTP attempts across retries and protocol fallbacks. */
export class ModelAttemptBudget {
  private used = 0;

  constructor(readonly maxAttempts = 3) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
      throw new Error("模型请求预算必须至少为 1");
  }

  acquire() {
    if (!this.canAttempt())
      throw new ModelAttemptBudgetExhaustedError(this.maxAttempts);
    this.used += 1;
    return this.used;
  }

  canAttempt() {
    return this.used < this.maxAttempts;
  }

  get attemptsUsed() {
    return this.used;
  }

  get remaining() {
    return Math.max(0, this.maxAttempts - this.used);
  }
}
