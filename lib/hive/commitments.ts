import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Ledger } from "@/lib/council/ledger";

/**
 * Commitment Ledger (reference/sent2.md v1.3 §3.3). Append-only: rows are never deleted, and the
 * only fields that change are `status` and `breakageRecord`, only here. Breaking is allowed but
 * never silent: it needs SYMBIONT PRIME's approval, writes a breakage record and a `commitment.broken`
 * ledger event, and enters the Self-Model as a new version recording the change.
 * The ledger simulates functional stakes (constraint, consistency, record); it does not claim the
 * Hive suffers from breakage.
 */

export type CostType = "reputational" | "relational" | "epistemic" | "ethical";
export const BREAK_APPROVER = "SYMBIONT_PRIME";

export class CommitmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitmentError";
  }
}

export interface CommitmentRow {
  id: string;
  cycleMade: number;
  text: string;
  contextRef: string;
  costType: string;
  status: string;
  breakageRecord: string | null;
}

export class CommitmentLedger {
  constructor(private readonly db: PrismaClient, private readonly ledger: Ledger) {}

  async commit(text: string, cycleMade: number, contextRef: string, costType: CostType): Promise<CommitmentRow> {
    return this.db.commitment.create({ data: { text, cycleMade, contextRef, costType } });
  }

  async active(): Promise<CommitmentRow[]> {
    return this.db.commitment.findMany({ where: { status: "active" }, orderBy: [{ cycleMade: "asc" }, { createdAt: "asc" }] });
  }

  async all(): Promise<CommitmentRow[]> {
    return this.db.commitment.findMany({ orderBy: [{ cycleMade: "asc" }, { createdAt: "asc" }] });
  }

  async honor(id: string): Promise<void> {
    const c = await this.db.commitment.findUnique({ where: { id } });
    if (!c) throw new CommitmentError(`unknown commitment ${id}`);
    if (c.status !== "active") throw new CommitmentError(`commitment ${id} is ${c.status}`);
    await this.db.commitment.update({ where: { id }, data: { status: "honored" } });
  }

  /**
   * Breaks an active commitment. `approvedBy` must be SYMBIONT_PRIME (the arbiter's AMEND decision
   * in P5 is the approval); anything else throws. Writes the breakage record, a ledger event, and a
   * promoted Self-Model version whose `broken_commitments` lists the change.
   */
  async break(id: string, args: { reason: string; approvedBy: string; cycleNo: number; cycleId: string }): Promise<CommitmentRow> {
    if (args.approvedBy !== BREAK_APPROVER) throw new CommitmentError(`only ${BREAK_APPROVER} may approve breaking a commitment (got "${args.approvedBy}")`);
    if (!args.reason.trim()) throw new CommitmentError("a breakage needs a reason");
    const c = await this.db.commitment.findUnique({ where: { id } });
    if (!c) throw new CommitmentError(`unknown commitment ${id}`);
    if (c.status !== "active") throw new CommitmentError(`commitment ${id} is ${c.status}, cannot break`);
    const record = { cycle: args.cycleNo, reason: args.reason, approved_by: BREAK_APPROVER };
    const updated = await this.db.commitment.update({ where: { id }, data: { status: "broken", breakageRecord: JSON.stringify(record) } });
    await this.ledger.record({ kind: "commitment.broken", cycleId: args.cycleId, subjectType: "commitment", subjectId: id, payload: { text: c.text, ...record } });

    // the breakage enters the Self-Model
    const sm = await this.db.selfModelVersion.findFirst({ where: { promoted: true }, orderBy: { version: "desc" } });
    const last = await this.db.selfModelVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    const body = sm ? (JSON.parse(sm.body) as Record<string, unknown>) : {};
    const broken = Array.isArray(body.broken_commitments) ? (body.broken_commitments as unknown[]) : [];
    await this.db.selfModelVersion.create({
      data: {
        version: (last?.version ?? 0) + 1,
        body: JSON.stringify({ ...body, broken_commitments: [...broken, { id, text: c.text, ...record }] }),
        deltaFrom: sm?.version ?? null,
        cycleId: args.cycleId,
        promoted: true,
      },
    });
    return updated;
  }
}
