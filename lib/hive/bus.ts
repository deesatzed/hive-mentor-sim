import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { getDb } from "@/lib/council/db";
import type { Ledger } from "@/lib/council/ledger";
import { PrismaLedger } from "@/lib/council/ledger";
import type { Envelope, EnvelopeDraft } from "./envelope";
import { EnvelopeDraftSchema, isWhisper, WhisperBodySchema } from "./envelope";
import { dotted, PermissionError, PolicyEngine } from "./permissions";

/**
 * SynapseBus (sent2 v1.2 §3.3): the only way entities communicate, and the ONLY writer of
 * BusMessage (append-only). Order: authenticate → validate → authorize → rate-limit → stamp → persist.
 * Every denial is persisted with authorized=false, ledgered as `bus.denied`, and thrown.
 */

export class AuthenticationError extends Error {
  constructor(entityId: string, reason: string) {
    super(`UNAUTHENTICATED: ${entityId} — ${reason}`);
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends Error {
  constructor(entityId: string) {
    super(`RATE LIMIT: ${entityId} already whispered this cycle`);
    this.name = "RateLimitError";
  }
}

/** Issued once per entity by the bus; the orchestrator holds it and passes it on each publish. */
export interface Credential {
  readonly entityId: string;
  readonly token: string;
}

export interface BusOptions {
  policy: PolicyEngine;
  /** Entity ids that may be registered (the roster). */
  knownEntities: Iterable<string>;
  db?: PrismaClient;
  ledger?: Ledger;
  maxWhispersPerEntityPerCycle?: number;
}

export class SynapseBus {
  private readonly policy: PolicyEngine;
  private readonly known: Set<string>;
  private readonly db: PrismaClient;
  private readonly ledger: Ledger;
  private readonly maxWhispers: number;
  private readonly tokens = new Map<string, string>();
  private cycle: { id: string; no: number } | null = null;
  private transcript: Envelope[] = [];
  private whispered = new Map<string, number>();

  constructor(o: BusOptions) {
    this.policy = o.policy;
    this.known = new Set(o.knownEntities);
    this.db = o.db ?? getDb();
    this.ledger = o.ledger ?? new PrismaLedger(this.db);
    this.maxWhispers = o.maxWhispersPerEntityPerCycle ?? 1;
  }

  /** Issues a credential to a roster entity. Unknown ids are refused. */
  register(entityId: string): Credential {
    if (!this.known.has(entityId)) throw new AuthenticationError(entityId, "not a roster entity");
    const token = randomBytes(16).toString("hex");
    this.tokens.set(entityId, token);
    return { entityId, token };
  }

  /** Starts a heartbeat cycle: resets rate limits; the transcript of earlier cycles is kept. */
  startCycle(cycleId: string, cycleNo: number): void {
    this.cycle = { id: cycleId, no: cycleNo };
    this.whispered.clear();
  }

  get currentCycle() {
    return this.cycle;
  }

  async publish(cred: Credential | null | undefined, draft: EnvelopeDraft): Promise<Envelope> {
    if (!this.cycle) throw new Error("bus.publish before startCycle");
    const from = String((draft as { from?: unknown }).from ?? "");
    const messageId = `msg_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

    const deny = async (err: Error): Promise<never> => {
      await this.persist(messageId, draft, false, err.message);
      await this.ledger.record({
        kind: "bus.denied",
        cycleId: this.cycle!.id,
        subjectType: "entity",
        subjectId: from,
        payload: { messageId, to: (draft as { to?: unknown }).to ?? null, type: (draft as { type?: unknown }).type ?? null, error: err.name, reason: err.message },
      });
      throw err;
    };

    // authenticate: the credential must be the one this bus issued to the claimed sender
    if (!cred || cred.entityId !== from || this.tokens.get(from) !== cred.token) {
      return deny(new AuthenticationError(from || "(none)", !cred ? "no credential" : cred.entityId !== from ? "credential is for another entity" : "invalid token"));
    }

    const parsed = EnvelopeDraftSchema.safeParse(draft);
    if (!parsed.success) return deny(new Error(`invalid envelope: ${parsed.error.message.slice(0, 300)}`));
    const env = parsed.data;
    if (isWhisper(env.body)) {
      const wb = WhisperBodySchema.safeParse(env.body);
      if (!wb.success) return deny(new Error(`invalid whisper body: ${wb.error.message.slice(0, 300)}`));
      env.body = wb.data;
    }

    try {
      this.policy.authorizePublish(from, env.to, env.type);
    } catch (e) {
      if (e instanceof PermissionError) return deny(e);
      throw e;
    }

    if (isWhisper(env.body)) {
      const n = this.whispered.get(from) ?? 0;
      if (n >= this.maxWhispers) return deny(new RateLimitError(from));
      this.whispered.set(from, n + 1);
    }

    const stamped: Envelope = {
      ...env,
      message_id: messageId,
      cycle_id: this.cycle.id,
      cycle_no: this.cycle.no,
      created_at: new Date().toISOString(),
    };
    await this.persist(messageId, stamped, true, null);
    this.transcript.push(stamped);
    return stamped;
  }

  /** Messages addressed to a channel (or its sub-channels) or to the entity; needs a read grant. */
  read(cred: Credential, channel: string): Envelope[] {
    this.authenticate(cred);
    this.policy.authorizeRead(cred.entityId, channel);
    const c = dotted(channel);
    return this.transcript.filter((e) => {
      const to = dotted(e.to);
      return to === c || to.startsWith(`${c}.`) || e.to === cred.entityId;
    });
  }

  /** The full transcript: WITNESS's chartered privilege (read: ["*"]); anyone else throws. */
  fullTranscript(cred: Credential): Envelope[] {
    this.authenticate(cred);
    this.policy.authorizeRead(cred.entityId, "*");
    return [...this.transcript];
  }

  /** Cycle-scoped slice for the cycle trace (orchestrator use; not an entity read). */
  cycleTranscript(cycleId = this.cycle?.id): Envelope[] {
    return this.transcript.filter((e) => e.cycle_id === cycleId);
  }

  private authenticate(cred: Credential) {
    if (!cred || this.tokens.get(cred.entityId) !== cred.token) throw new AuthenticationError(cred?.entityId ?? "(none)", "invalid token");
  }

  private async persist(id: string, env: Partial<Envelope> | EnvelopeDraft, authorized: boolean, denyReason: string | null) {
    const e = env as Partial<Envelope>;
    await this.db.busMessage.create({
      data: {
        id,
        cycleId: this.cycle!.id,
        taskId: String(e.task_id ?? ""),
        traceId: String(e.trace_id ?? ""),
        inReplyTo: e.in_reply_to ?? null,
        fromEntity: String(e.from ?? ""),
        toEntity: String(e.to ?? ""),
        type: String(e.type ?? ""),
        scope: String(e.scope ?? ""),
        urgency: String(e.urgency ?? "normal"),
        body: JSON.stringify(e.body ?? {}),
        provenance: JSON.stringify(e.provenance ?? {}),
        authorized,
        denyReason,
      },
    });
  }
}
