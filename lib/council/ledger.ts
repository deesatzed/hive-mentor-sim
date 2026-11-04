import "server-only";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { getDb } from "./db";

/**
 * The ONLY writer of LedgerEvent (append-only). Never update or delete rows here or anywhere.
 * Kinds: decision.<purpose> | llm.<promptId> | quote.rejected | bus.denied | decision.model_unavailable | ...
 */

export interface LedgerInput {
  kind: string;
  cycleId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  payload?: Record<string, unknown>;
  model?: string | null;
  calibrated?: boolean;
  costUsd?: number;
  latencyMs?: number | null;
  refs?: string[];
}

export interface Ledger {
  record(ev: LedgerInput): Promise<{ id: string }>;
}

export const PREVIEW_CHARS = 200;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Compact summary of a large input: SHA-256 hash plus a ≤ 200-char preview. */
export function summarizeInput(input: unknown): { hash: string; preview: string } {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return { hash: sha256(text), preview: text.slice(0, PREVIEW_CHARS) };
}

export class PrismaLedger implements Ledger {
  constructor(private readonly db: PrismaClient = getDb()) {}

  async record(ev: LedgerInput): Promise<{ id: string }> {
    const row = await this.db.ledgerEvent.create({
      data: {
        kind: ev.kind,
        cycleId: ev.cycleId ?? null,
        subjectType: ev.subjectType ?? null,
        subjectId: ev.subjectId ?? null,
        payload: JSON.stringify(ev.payload ?? {}),
        model: ev.model ?? null,
        calibrated: ev.calibrated ?? true,
        costUsd: ev.costUsd ?? 0,
        latencyMs: ev.latencyMs ?? null,
        refs: JSON.stringify(ev.refs ?? []),
      },
      select: { id: true },
    });
    return row;
  }
}
