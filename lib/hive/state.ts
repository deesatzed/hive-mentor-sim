import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { normalizeClaim } from "./attention";

/**
 * Scoped memory (sent2 v1.2 §3.7). Three scopes: private (entity working state), project (this
 * session), hive (approved identity, lessons, canon). Append-only: the only updates anywhere are
 * `priority` (decay) and `resolvedCycle` (CONFLICT markers), and only in this file.
 * Decay touches retrieval priority, never records; canon is exempt.
 */

export type Scope = "private" | "project" | "hive";
export type MemoryKind = "episode" | "lesson" | "canon" | "conflict_marker";
export type Certainty = "verified" | "inferred" | "uncertain";

export interface MemoryInput {
  scope: Scope;
  ownerEntity: string;
  kind: MemoryKind;
  body: string;
  certainty: Certainty;
  createdCycle: number;
  sessionId: string;
  provenance: Record<string, unknown>;
}

export interface RetrievedMemory {
  id: string;
  body: string;
  kind: MemoryKind;
  certainty: Certainty;
  priority: number;
  score: number;
}

const STOP = new Set(
  "the a an and or but if of to in on for with at by from is are was were be been am i you me my your we our it this that what do does did about as so not no can could would should will just".split(" "),
);
const tokens = (s: string) => new Set(normalizeClaim(s).split(" ").filter((t) => t.length >= 3 && !STOP.has(t)));

export class HiveState {
  constructor(private readonly db: PrismaClient) {}

  async write(m: MemoryInput): Promise<string> {
    const row = await this.db.memoryRecord.create({
      data: {
        scope: m.scope,
        ownerEntity: m.ownerEntity,
        kind: m.kind,
        body: m.body,
        certainty: m.certainty,
        createdCycle: m.createdCycle,
        provenance: JSON.stringify({ ...m.provenance, sessionId: m.sessionId }),
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Hive-scope records plus this session's project records (never other sessions' project records). */
  private async visible(sessionId: string, kinds: MemoryKind[]) {
    const rows = await this.db.memoryRecord.findMany({
      where: { kind: { in: kinds }, scope: { in: ["hive", "project"] } },
      orderBy: [{ createdCycle: "desc" }, { id: "asc" }],
      take: 500,
    });
    return rows.filter((r) => r.scope === "hive" || (JSON.parse(r.provenance) as { sessionId?: string }).sessionId === sessionId);
  }

  /**
   * MNEME retrieval: priority × (1 + word overlap with the input), top k. Deterministic (ties by
   * recency then id). Lexical, not embedding-based, so it works without an embedding provider.
   */
  async retrieve(sessionId: string, input: string, k = 5): Promise<RetrievedMemory[]> {
    const q = tokens(input);
    const rows = await this.visible(sessionId, ["episode", "lesson", "canon"]);
    return rows
      .map((r) => {
        const overlap = [...tokens(r.body)].filter((t) => q.has(t)).length;
        return { id: r.id, body: r.body, kind: r.kind as MemoryKind, certainty: r.certainty as Certainty, priority: r.priority, score: r.priority * (1 + overlap), cycle: r.createdCycle };
      })
      .sort((a, b) => b.score - a.score || b.cycle - a.cycle || (a.id < b.id ? -1 : 1))
      .slice(0, k)
      .map(({ cycle: _c, ...m }) => m);
  }

  /** Normalized bodies of visible memories, for attention's dup(m). */
  async seenClaims(sessionId: string): Promise<Set<string>> {
    const rows = await this.visible(sessionId, ["episode", "lesson", "canon"]);
    return new Set(rows.map((r) => normalizeClaim(r.body)));
  }

  /** Priority decay γ for every non-canon record (append-only: only `priority` changes). */
  async decay(gamma: number): Promise<number> {
    const r = await this.db.memoryRecord.updateMany({ where: { kind: { not: "canon" } }, data: { priority: { multiply: gamma } } });
    return r.count;
  }

  async writeConflictMarker(body: string, createdCycle: number, sessionId: string, provenance: Record<string, unknown>): Promise<string> {
    return this.write({ scope: "hive", ownerEntity: "core.witness", kind: "conflict_marker", body, certainty: "verified", createdCycle, sessionId, provenance });
  }

  async openConflictMarkers(): Promise<{ id: string; body: string; createdCycle: number }[]> {
    const rows = await this.db.memoryRecord.findMany({ where: { kind: "conflict_marker", resolvedCycle: null }, orderBy: { createdCycle: "asc" } });
    return rows.map((r) => ({ id: r.id, body: r.body, createdCycle: r.createdCycle }));
  }

  async resolveConflictMarker(id: string, cycleNo: number): Promise<void> {
    await this.db.memoryRecord.update({ where: { id }, data: { resolvedCycle: cycleNo } });
  }
}
