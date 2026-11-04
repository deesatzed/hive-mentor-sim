import "server-only";

/**
 * Process-wide spend cap (docs/ARCHITECTURE.md "Cost control").
 * Every provider call: check() before, add() after.
 */

export class BudgetExceededError extends Error {
  constructor(public readonly spentUsd: number, public readonly capUsd: number) {
    super(`cost cap reached: spent $${spentUsd} of $${capUsd}`);
    this.name = "BudgetExceededError";
  }
}

export class CostMeter {
  private spent = 0;
  private readonly byModel = new Map<string, number>();

  constructor(public readonly capUsd: number) {
    if (!Number.isFinite(capUsd) || capUsd < 0) throw new Error(`invalid cost cap: ${capUsd}`);
  }

  /** Throws BudgetExceededError if the cap is already reached. */
  check(): void {
    if (this.spent >= this.capUsd) throw new BudgetExceededError(this.spent, this.capUsd);
  }

  /** Records a measured cost; throws if this call pushed spend to or past the cap. */
  add(model: string, costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error(`invalid cost: ${costUsd}`);
    this.spent += costUsd;
    this.byModel.set(model, (this.byModel.get(model) ?? 0) + costUsd);
    this.check();
  }

  get spentUsd(): number {
    return this.spent;
  }

  breakdown(): Record<string, number> {
    return Object.fromEntries(this.byModel);
  }
}

export const DEFAULT_COST_CAP_USD = 5;

export function costCapFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.COST_CAP_USD?.trim();
  if (!raw) return DEFAULT_COST_CAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`COST_CAP_USD is not a non-negative number: '${raw}'`);
  return n;
}
