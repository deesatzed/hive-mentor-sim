import "server-only";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { sqlitePathFromUrl } from "@/lib/council/db";
import { PrismaLedger } from "@/lib/council/ledger";
import { resolveProviderConfig, type Env } from "@/lib/council/providers";
import { hiveConfig, type HiveConfig } from "./config";

/**
 * M10 operator tools: /settings (read-only config view), /ledger (events, spend, bus transcript),
 * and the database reset (docs/PRODUCT_SPEC.md §9–10, ARCHITECTURE `admin/reset`).
 */

// ---------------------------------------------------------------- settings

export function settingsView(env: Env = process.env, cfg: HiveConfig = hiveConfig()) {
  const mock = (env.USE_MOCK_PROVIDERS ?? "").trim().toLowerCase() === "true";
  let providers: Record<string, unknown>;
  try {
    const r = resolveProviderConfig(env, cfg.models ?? {});
    if (r.mode === "cloud") {
      // never the key: only model IDs and where each came from
      providers = {
        mode: "cloud",
        tiers: r.tiers,
        manager: r.manager,
        grader: r.grader,
        decisionChain: r.decisionChain,
        embeddingChain: r.embeddingChain,
        rerankChain: r.rerankChain,
      };
    } else if (r.mode === "local") providers = { mode: "local", baseUrl: r.baseUrl, llmModel: r.llmModel, embedModel: r.embedModel };
    else providers = { mode: "mock" };
  } catch (e) {
    providers = { mode: (env.PROVIDER_MODE ?? "cloud").trim() || "cloud", error: (e as Error).message };
  }
  return {
    mock,
    providers,
    orchestration: cfg.orchestration.mode,
    edictModule: cfg.edict_module.enabled,
    honestyClause: cfg.honesty_clause.enabled,
    advisors: cfg.advisors.enabled,
    milestone: cfg.eval.current_milestone,
    database: path.basename(sqlitePathFromUrl(env.DATABASE_URL ?? "file:./dev.db")),
  };
}

export async function spendToDate(db: PrismaClient) {
  const a = await db.ledgerEvent.aggregate({ _sum: { costUsd: true }, _count: true });
  return { costUsd: a._sum.costUsd ?? 0, events: a._count };
}

// ---------------------------------------------------------------- ledger

export interface LedgerQuery {
  kind?: string;
  cycleId?: string;
  limit?: number;
  before?: string;
}

/** Short probabilities summary from a decision payload ({p: {...}} or {probabilities: {...}}). */
export function probSummary(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  const src = (o.probabilities ?? o.p ?? o.answers) as Record<string, unknown> | undefined;
  if (!src || typeof src !== "object") return null;
  const parts = Object.entries(src)
    .filter(([, v]) => typeof v === "number")
    .slice(0, 6)
    .map(([k, v]) => `${k} ${(v as number).toFixed(2)}`);
  const more = Object.keys(src).length - parts.length;
  return parts.length ? parts.join(" · ") + (more > 0 ? ` · +${more} more` : "") : null;
}

export async function ledgerView(db: PrismaClient, q: LedgerQuery = {}) {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const where = {
    ...(q.kind ? { kind: q.kind.endsWith("*") ? { startsWith: q.kind.slice(0, -1) } : q.kind } : {}),
    ...(q.cycleId ? { cycleId: q.cycleId } : {}),
  };
  const [rows, filtered, total, kinds] = await Promise.all([
    db.ledgerEvent.findMany({ where: { ...where, ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit }),
    db.ledgerEvent.aggregate({ where, _sum: { costUsd: true }, _count: true }),
    spendToDate(db),
    db.ledgerEvent.groupBy({ by: ["kind"], _count: true, _sum: { costUsd: true }, orderBy: { kind: "asc" } }),
  ]);
  return {
    total,
    filtered: { costUsd: filtered._sum.costUsd ?? 0, events: filtered._count },
    kinds: kinds.map((k) => ({ kind: k.kind, events: k._count, costUsd: k._sum.costUsd ?? 0 })),
    events: rows.map((r) => {
      let payload: unknown = {};
      try {
        payload = JSON.parse(r.payload);
      } catch {
        /* stored as text */
      }
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        kind: r.kind,
        cycleId: r.cycleId,
        subject: r.subjectType ? `${r.subjectType}${r.subjectId ? `:${r.subjectId}` : ""}` : null,
        model: r.model,
        calibrated: r.calibrated,
        probabilities: probSummary(payload),
        costUsd: r.costUsd,
        latencyMs: r.latencyMs,
      };
    }),
  };
}

/** Every bus envelope of one cycle, oldest first, with its authorization result. */
export async function busTranscript(db: PrismaClient, cycleId: string) {
  const rows = await db.busMessage.findMany({ where: { cycleId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((m) => {
    let kind: string | null = null;
    try {
      kind = (JSON.parse(m.body) as { kind?: string }).kind ?? null;
    } catch {
      /* body not JSON */
    }
    return { id: m.id, createdAt: m.createdAt.toISOString(), from: m.fromEntity, to: m.toEntity, type: m.type, scope: m.scope, kind, authorized: m.authorized, denyReason: m.denyReason };
  });
}

// ---------------------------------------------------------------- reset

/** The operator types this exactly to reset. */
export const RESET_PHRASE = "reset hive state";

export class ResetError extends Error {}

/**
 * Hive experience: everything the Hive accumulated by running. Deleted by reset, in an order that
 * respects foreign keys (Cycle cascades from HiveSession).
 */
export const RESET_TABLES = [
  "busMessage",
  "conclaveRun",
  "hiveRuling",
  "memoryRecord",
  "commitment",
  "egoAudit",
  "interoceptionSample",
  "hivePrediction",
  "signal",
  "patternSurface",
  "evalRun",
  "hiveSession",
  "selfModelVersion",
] as const;

/**
 * Kept by reset: the corpus (Mentor, CorpusWork, CorpusChunk, MentorPrinciple, MentorAnswer), the
 * seed (Situation, Voice), the operator's approvals (Formation, HivePrinciple), and LedgerEvent
 * (append-only; the reset itself is recorded there).
 */
export const RESET_KEPT = ["Mentor", "CorpusWork", "CorpusChunk", "MentorPrinciple", "MentorAnswer", "Situation", "Voice", "Formation", "FormationMember", "HivePrinciple", "OperatorSetting", "LedgerEvent"];

/**
 * Resets the Hive's experience to its seeded state (Self-Model v1). Takes a SQLite backup first
 * (backups/<db>-before-reset-<timestamp>.db) and refuses unless `confirm` equals RESET_PHRASE.
 */
export async function resetHiveState(db: PrismaClient, opts: { confirm: string; dbUrl?: string; cfg?: HiveConfig; backupDir?: string }) {
  if (opts.confirm !== RESET_PHRASE) throw new ResetError(`Type "${RESET_PHRASE}" exactly to reset.`);
  const cfg = opts.cfg ?? hiveConfig();
  const file = sqlitePathFromUrl(opts.dbUrl ?? process.env.DATABASE_URL ?? "file:./dev.db");
  const dir = opts.backupDir ?? path.join(process.cwd(), "backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(dir, `${path.basename(file, ".db")}-before-reset-${stamp}.db`);
  // VACUUM INTO writes a consistent copy of the live database through the same connection
  await db.$executeRawUnsafe(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);

  const counts: Record<string, number> = {};
  await db.$transaction(async (tx) => {
    for (const t of RESET_TABLES) {
      const r = await (tx[t] as unknown as { deleteMany: () => Promise<{ count: number }> }).deleteMany();
      counts[t] = r.count;
    }
    await tx.selfModelVersion.create({ data: { version: 1, body: JSON.stringify(cfg.self_model_seed), promoted: true } });
  });
  await new PrismaLedger(db).record({ kind: "db.reset", payload: { deleted: counts, kept: RESET_KEPT, backup: path.basename(backup) } });
  return { deleted: counts, kept: RESET_KEPT, backup };
}
