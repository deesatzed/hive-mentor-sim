import "server-only";

/**
 * Records measured spend per model for the process (reported in traces and reports).
 * There is no spending cap: the owner limits spend with per-key limits on OpenRouter
 * (owner decision, 2026-11-04). Every provider call adds its measured `usage.cost`.
 */
export class CostMeter {
  private spent = 0;
  private readonly byModel = new Map<string, number>();

  add(model: string, costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error(`invalid cost: ${costUsd}`);
    this.spent += costUsd;
    this.byModel.set(model, (this.byModel.get(model) ?? 0) + costUsd);
  }

  get spentUsd(): number {
    return this.spent;
  }

  breakdown(): Record<string, number> {
    return Object.fromEntries(this.byModel);
  }
}
