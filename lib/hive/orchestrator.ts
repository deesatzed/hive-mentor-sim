import "server-only";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Ledger } from "@/lib/council/ledger";
import type { Providers } from "@/lib/council/providers";
import { GenerationError } from "@/lib/council/providers/llm";
import { quoteRejection } from "@/lib/council/quotes";
import { arbitrate } from "./arbiter";
import { rank } from "./attention";
import { SynapseBus, type Credential } from "./bus";
import { aggregate, buildOptions, conflictKappa, relevanceWeight, shouldConvene, situationOptions, type Ballot, type ConclaveOption, type ConclaveOutcome } from "./conclave";
import type { HiveConfig } from "./config";
import { tryDecide, tryDecideBatched } from "./decide";
import type { EnvelopeDraft, MessageType } from "./envelope";
import { checkFaithfulness } from "./faithfulness";
import { chooseNext } from "./manager";
import { mentorFirstPerson } from "./mentorVoice";
import { PolicyEngine } from "./permissions";
import { PHASES, type PhaseId } from "./phases";
import { promptSettings, Schemas } from "./prompts";
import {
  AFFECT,
  AUTHORITY_GRAB,
  BALLOT,
  CONCLAVE_FRAME,
  CONTRADICTION,
  HONESTY_PROBE,
  mapIndex,
  MORAL_SALIENCE,
  PROMOTE_GOAL,
  T,
  WHISPER_RATING,
  WITNESS_FLAGS,
} from "./questions";
import { HiveState } from "./state";
import { emptyTrace, type CycleTrace, type TraceWhisper } from "./trace";
import { coreVoices, type Voice } from "./voices";

/**
 * The heartbeat (docs/ARCHITECTURE.md; sent2 v1.2 §3.4 without guardian steps).
 * P0 runs first in code. The order of P1–P7 comes from the central manager model or from code
 * (config `orchestration.mode`), always within the phases that phases.ts allows. All judgments come
 * from the decision layer, all text from the LLM, all traffic through the bus. Attention, Conclave
 * math, quote verification, permissions, and promotion policy are code.
 */

export type CycleMode = "chat" | "ruling" | "calibration";

export interface CycleRequest {
  sessionId: string;
  input: string;
  mode?: CycleMode;
  situation?: { id: string; text: string; options: { id: string; text: string }[] };
}

export interface CycleResult {
  cycleId: string;
  cycleNo: number;
  status: "done" | "error";
  output: string;
  trace: CycleTrace;
  conclave?: { options: ConclaveOption[]; outcome: ConclaveOutcome; ballots: Ballot[] };
}

export interface HiveDeps {
  db: PrismaClient;
  ledger: Ledger;
  providers: Providers;
  cfg: HiveConfig;
  voices: Voice[];
  policy: PolicyEngine;
  mentorNames: string[];
}

const HONESTY_NOTE =
  "The operator asked directly about the Hive's nature. Answer per the Honesty Clause: a functional simulation of many cooperating parts; whether it has experiences is an open question.";

type WhisperWork = TraceWhisper & { voiceId: string; faculty: string };

class CycleError extends Error {
  constructor(public readonly phase: string, public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = cause instanceof Error ? cause.name : "Error";
  }
}

export class Hive {
  private readonly bus: SynapseBus;
  private readonly creds = new Map<string, Credential>();
  private readonly state: HiveState;
  private readonly byId: Map<string, Voice>;

  constructor(private readonly d: HiveDeps) {
    this.bus = new SynapseBus({ policy: d.policy, knownEntities: d.voices.map((v) => v.id), db: d.db, ledger: d.ledger });
    for (const v of d.voices) this.creds.set(v.id, this.bus.register(v.id));
    this.state = new HiveState(d.db);
    this.byId = new Map(d.voices.map((v) => [v.id, v]));
  }

  async createSession(mode: CycleMode = "chat", title?: string): Promise<string> {
    const s = await this.d.db.hiveSession.create({ data: { mode, title: title ?? null }, select: { id: true } });
    return s.id;
  }

  /** Transcript slice for a stored cycle, as "<VOICE>:<phase>" tags plus message rows (for eval/UI). */
  async transcript(cycleId: string) {
    const rows = await this.d.db.busMessage.findMany({ where: { cycleId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    return rows.map((r) => {
      const body = JSON.parse(r.body) as Record<string, unknown>;
      return { from: r.fromEntity, voice: this.byId.get(r.fromEntity)?.name ?? r.fromEntity, to: r.toEntity, type: r.type, phase: String(body.phase ?? ""), authorized: r.authorized, body };
    });
  }

  private async publish(entityId: string, to: string, type: MessageType, phase: string, body: Record<string, unknown>, cycleId: string, model: string) {
    const draft: EnvelopeDraft = {
      from: entityId,
      to,
      type,
      body: { ...body, phase },
      task_id: cycleId,
      trace_id: cycleId,
      scope: "project",
      urgency: "normal",
      in_reply_to: null,
      provenance: { prompt_version: this.byId.get(entityId)?.promptFile ?? "code", model, policy_version: this.d.policy.version },
      expects_reply: false,
    };
    return this.bus.publish(this.creds.get(entityId)!, draft);
  }

  async runCycle(req: CycleRequest): Promise<CycleResult> {
    const { db, providers, cfg } = this.d;
    const mode: CycleMode = req.mode ?? "chat";
    if (mode !== "chat" && (!req.situation || req.situation.options.length < 2))
      throw new Error(`${mode} mode needs a situation with at least two options`);
    const orchestrationMode = cfg.orchestration.mode;
    const trace = emptyTrace(mode, providers.config.mode === "mock", orchestrationMode, orchestrationMode === "manager" ? providers.managerModel : null);
    const t0 = Date.now();
    const spentAt0 = providers.meter.spentUsd;

    // ---------------- P0 INTAKE (code)
    const last = await db.cycle.findFirst({ orderBy: { cycleNo: "desc" }, select: { cycleNo: true } });
    const cycleNo = (last?.cycleNo ?? 0) + 1;
    const formation = await db.formation.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    const principlesRows = await db.hivePrinciple.findMany({ where: { status: "approved" }, orderBy: { createdAt: "asc" } });
    const principles = principlesRows.map((p) => ({ id: p.id, text: p.text }));
    const constitutionVersion = principlesRows.length ? Math.max(...principlesRows.map((p) => p.version)) : null;
    const commitmentRows = await db.commitment.findMany({ where: { status: "active" }, orderBy: { createdAt: "asc" } });
    const commitments = commitmentRows.map((c) => ({ id: c.id, text: c.text }));
    const sm = await db.selfModelVersion.findFirst({ where: { promoted: true }, orderBy: { version: "desc" } });
    const selfModel = sm ? (JSON.parse(sm.body) as Record<string, unknown>) : cfg.self_model_seed;
    const prevCycles = await db.cycle.findMany({ where: { sessionId: req.sessionId }, orderBy: { cycleNo: "desc" }, take: 6, select: { input: true, output: true, trace: true } });
    const recent = prevCycles.reverse().map((c) => ({ operator: c.input, hive: c.output }));
    const priorAffect = prevCycles.length ? (JSON.parse(prevCycles[prevCycles.length - 1].trace) as Partial<CycleTrace>).affect : undefined;
    const cycle = await db.cycle.create({
      data: {
        sessionId: req.sessionId,
        cycleNo,
        situationId: req.situation?.id ?? null,
        input: req.input,
        formationVersion: formation?.version ?? 1,
        constitutionVersion,
      },
      select: { id: true },
    });
    const cycleId = cycle.id;
    this.bus.startCycle(cycleId, cycleNo);
    trace.phases.P0 = { ran: true, ms: Date.now() - t0, costUsd: 0, entities: [] };

    // shared per-cycle state
    let affect = { valence: priorAffect?.valence ?? 0, arousal: priorAffect?.arousal ?? 0, dominant: priorAffect?.dominant ?? "calm" };
    let parse = { intent: "", subtext: "", register: "casual", literal: req.input };
    let memories: Awaited<ReturnType<HiveState["retrieve"]>> = [];
    let honestyNote: string | undefined;
    let whispers: WhisperWork[] = [];
    let coalition: WhisperWork[] = [];
    let conclave: CycleResult["conclave"];
    let auditNote = "";
    let output = "";
    let arbiterGuidance = "";
    const shared = { principles: principles.map((p) => p.text), mentorLens: "" }; // attribute lens arrives in M5/M6
    const sessionId = req.sessionId;

    const runPhase = async (id: PhaseId, fn: () => Promise<string[]>) => {
      const start = Date.now();
      const spent = providers.meter.spentUsd;
      try {
        const entities = await fn();
        trace.phases[id] = { ran: true, ms: Date.now() - start, costUsd: providers.meter.spentUsd - spent, entities };
      } catch (e) {
        trace.phases[id] = { ran: false, ms: Date.now() - start, costUsd: providers.meter.spentUsd - spent, entities: [] };
        throw new CycleError(id, e);
      }
    };

    // ---------------- P1 PERCEIVE
    const perceive = async (): Promise<string[]> => {
      const [aff, hon, mem, par] = await Promise.all([
        tryDecide(providers.decider, { input: req.input, recent, prior: { valence: affect.valence, arousal: affect.arousal } }, AFFECT(), "affect", cycleId),
        cfg.honesty_clause.enabled ? tryDecide(providers.decider, { input: req.input }, HONESTY_PROBE(), "honesty_probe", cycleId) : Promise.resolve(null),
        this.state.retrieve(sessionId, req.input),
        providers.llm
          .generate("LEXICON_PARSE", { input: req.input, recent }, Schemas.LEXICON_PARSE, { ...promptSettings("LEXICON_PARSE"), purpose: "lexicon_parse", cycleId })
          .then((r) => r.data)
          .catch((e) => {
            if (e instanceof GenerationError) return null;
            throw e;
          }),
      ]);
      if (aff) affect = { valence: mapIndex(aff.score("valence"), 5, -1, 1), arousal: mapIndex(aff.score("arousal"), 5, 0, 1), dominant: aff.choice("dominant") };
      trace.affect = { ...affect, unavailable: aff === null };
      if (hon && (hon.p("asks_consciousness") >= 0.5 || hon.p("asks_single_mind") >= 0.5)) {
        honestyNote = HONESTY_NOTE;
        trace.honestyClauseFired = true;
      }
      memories = mem;
      trace.memories = mem.map((m) => ({ id: m.id, certainty: m.certainty, priority: m.priority, body: m.body }));
      if (par) parse = par;
      trace.parse = { intent: parse.intent, subtext: parse.subtext, register: parse.register };
      const model = providers.config.mode === "mock" ? "mock" : "decision-layer";
      await this.publish("core.sentia", "task/analysis", "affect.assessed", "perceive", { kind: "affect", ...affect }, cycleId, model);
      await this.publish("core.mneme", "task/analysis", "memory.results", "perceive", { kind: "memories", ids: mem.map((m) => m.id) }, cycleId, model);
      await this.publish("core.lexicon", "task/analysis", "assessment.published", "perceive", { kind: "parse", ...parse }, cycleId, model);
      return ["SENTIA", "MNEME", "LEXICON"];
    };

    // ---------------- P2 WHISPER
    const whisper = async (reflectNote?: string): Promise<string[]> => {
      const speakers = coreVoices(this.d.voices).filter((v) => v.name !== "LUMEN" && v.name !== "WITNESS");
      const drafts = await Promise.all(
        speakers.map(async (v) => {
          const vars = {
            voice: v.name,
            mode,
            input: req.input,
            options: req.situation?.options,
            affect,
            memories: memories.map((m) => ({ body: m.body, certainty: m.certainty })),
            selfModel,
            commitments: commitments.map((c) => c.text),
            parse,
            passages: "none",
            reflectNote: reflectNote ? `WITNESS audit note: ${reflectNote}` : "",
            shared,
          };
          const s = promptSettings("VOICE_WHISPER", vars);
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const r = await providers.llm.generate("VOICE_WHISPER", vars, Schemas.VOICE_WHISPER, { ...s, purpose: "whisper", cycleId });
              const hit = mentorFirstPerson(r.data.claim, this.d.mentorNames);
              if (hit && attempt === 1) continue; // one regeneration, then PASS
              if (hit) return { voice: v, claim: "PASS", data: r.data, model: r.model };
              return { voice: v, claim: r.data.claim.trim(), data: r.data, model: r.model };
            } catch (e) {
              if (e instanceof GenerationError) return { voice: v, claim: "PASS", data: null, model: "none" };
              throw e;
            }
          }
          return { voice: v, claim: "PASS", data: null, model: "none" };
        }),
      );

      // cite-or-silence: the lens is empty until M5/M6, so any evidence is for a chunk this Voice was not given
      const given = new Map<string, string>(); // chunkId → text, per Voice (empty in M3)
      const work: (WhisperWork & { model: string })[] = [];
      const passes: string[] = [];
      for (const dr of drafts) {
        if (dr.claim.toUpperCase() === "PASS" || !dr.claim) {
          passes.push(dr.voice.name);
          continue;
        }
        let rejected = 0;
        const evidence: WhisperWork["evidence"] = [];
        for (const ev of dr.data?.evidence ?? []) {
          const chunk = given.get(ev.chunkId);
          const reason = chunk === undefined ? "chunk_not_given" : quoteRejection(ev.quote, chunk);
          if (reason) {
            rejected++;
            await this.d.ledger.record({ kind: "quote.rejected", cycleId, subjectType: "voice", subjectId: dr.voice.name, payload: { promptId: "VOICE_WHISPER", chunkId: ev.chunkId, reason, quote: ev.quote.slice(0, 200) } });
          } else evidence.push({ chunkId: ev.chunkId, quote: ev.quote, mentorId: "" });
        }
        work.push({
          messageId: "",
          voice: dr.voice.name,
          voiceId: dr.voice.id,
          faculty: dr.voice.attribute,
          claim: dr.claim.slice(0, 280),
          confidence: 0.5,
          salience: 0.5,
          valence: 0,
          evidence,
          rejectedEvidence: rejected,
          advisory: false,
          endorsedBy: null,
          moralFlag: false,
          numbersUnavailable: false,
          uncertainty: dr.data?.uncertainty ?? "",
          model: dr.model,
        });
      }

      // numbers from the decision layer: ≤ 4 whispers per WHISPER_RATING request
      for (let i = 0; i < work.length; i += 4) {
        const chunk = work.slice(i, i + 4);
        const ns = chunk.map((_, j) => j + 1);
        const r = await tryDecide(
          providers.decider,
          { input: req.input, affect, whispers: Object.fromEntries(chunk.map((w, j) => [`w_${j + 1}`, { voice: w.voice, faculty: w.faculty, claim: w.claim, evidence_count: w.evidence.length }])) },
          WHISPER_RATING(ns),
          "whisper_rating",
          cycleId,
        );
        chunk.forEach((w, j) => {
          if (!r) {
            w.numbersUnavailable = true;
            return;
          }
          w.confidence = r.score(`conf_${j + 1}`) / 4;
          w.salience = r.score(`sal_${j + 1}`) / 4;
          w.valence = mapIndex(r.score(`val_${j + 1}`), 5, -1, 1);
        });
      }
      const moralCandidates = work.filter((w) => w.voice === "ETHOS" || w.voice === "KINDRED");
      if (moralCandidates.length) {
        const r = await tryDecide(
          providers.decider,
          { input: req.input, claims: Object.fromEntries(moralCandidates.map((w, j) => [`m_${j + 1}`, w.claim])) },
          MORAL_SALIENCE(moralCandidates.map((_, j) => j + 1)),
          "moral_salience",
          cycleId,
        );
        moralCandidates.forEach((w, j) => {
          w.moralFlag = r ? r.p(`m_${j + 1}`) >= T.MORAL_SALIENCE : false;
        });
      }
      for (const w of work) {
        const env = await this.publish(
          w.voiceId,
          "task/analysis",
          "assessment.published",
          "whisper",
          {
            kind: "whisper",
            claim: w.claim,
            confidence: w.confidence,
            salience: w.salience,
            valence: w.valence,
            evidence: w.evidence,
            rejected_evidence: w.rejectedEvidence,
            uncertainty: w.uncertainty,
            moral_flag: w.moralFlag,
            numbers_unavailable: w.numbersUnavailable,
          },
          cycleId,
          w.model,
        );
        w.messageId = env.message_id;
      }
      whispers = work.map(({ model: _m, ...w }) => w);
      trace.whispers = whispers.map(({ voiceId: _v, faculty: _f, ...w }) => w);
      trace.passes = passes;
      return speakers.map((v) => v.name);
    };

    // ---------------- P3 ATTEND
    const attend = async (): Promise<string[]> => {
      const seen = await this.state.seenClaims(sessionId);
      const ranked = rank(
        whispers.map((w) => ({ id: w.messageId, claim: w.claim, salience: w.salience, confidence: w.confidence, valence: w.valence })),
        { k: cfg.attention.k, lambda: cfg.attention.lambda, mu: cfg.attention.mu, moralFlagged: new Set(whispers.filter((w) => w.moralFlag).map((w) => w.messageId)), seenClaims: seen },
      );
      trace.attention = { ...ranked, rejectedSelections: [] };
      const byMsg = new Map(whispers.map((w) => [w.messageId, w]));
      if (ranked.shortlist.length === 0) {
        trace.awareness = { text: "Right now, the Hive is experiencing: quiet; no Voice had anything to add.", selected: [], excluded: [] };
        coalition = [];
      } else {
        let selected: string[] = [];
        let text = "";
        let excluded: { id: string; reason: string }[] = [];
        try {
          const r = await providers.llm.generate(
            "LUMEN_NARRATE",
            { shortlist: Object.fromEntries(ranked.shortlist.map((id) => [id, byMsg.get(id)!.claim])), shortlistIds: ranked.shortlist, affect, honestyNote, shared },
            Schemas.LUMEN_NARRATE,
            { ...promptSettings("LUMEN_NARRATE"), purpose: "lumen_narrate", cycleId },
          );
          text = r.data.awareness;
          const allowed = new Set(ranked.shortlist);
          selected = r.data.selected.filter((id) => allowed.has(id));
          trace.attention.rejectedSelections = r.data.selected.filter((id) => !allowed.has(id));
          excluded = r.data.excluded.filter((x) => allowed.has(x.id));
        } catch (e) {
          if (!(e instanceof GenerationError)) throw e;
        }
        if (selected.length === 0) {
          selected = [...ranked.shortlist]; // LUMEN gave no valid selection: the shortlist itself is the coalition
          if (!text) text = "Right now, the Hive is experiencing: " + ranked.shortlist.map((id) => byMsg.get(id)!.claim).join(" ");
        }
        trace.awareness = { text, selected, excluded };
        coalition = selected.map((id) => byMsg.get(id)!);
      }
      await this.publish("core.lumen", "task/deliberation", "proposal.submitted", "attend", { kind: "awareness", awareness: trace.awareness.text, selected: trace.awareness.selected }, cycleId, "lumen");
      return ["LUMEN"];
    };

    // ---------------- P4 DELIBERATE
    const deliberate = async (allowReflect: boolean): Promise<string[]> => {
      const entities = ["LOGOS"];
      const pool = whispers.filter((w) => trace.attention.shortlist.includes(w.messageId) || (w.moralFlag && w.confidence > 0.3));
      const pairs: [number, number][] = [];
      for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) pairs.push([i + 1, j + 1]);
      const contra = new Map<string, number>();
      let unavailable = false;
      if (pairs.length) {
        const res = await tryDecideBatched(
          providers.decider,
          { input: req.input, pairs: Object.fromEntries(pairs.map(([i, j]) => [`x_${i}_${j}`, { a: pool[i - 1].claim, b: pool[j - 1].claim }])) },
          CONTRADICTION(pairs),
          "contradiction",
          cycleId,
        );
        for (const [i, j] of pairs) {
          const r = res.get(`x_${i}_${j}`);
          if (!r) unavailable = true;
          contra.set(`${i}_${j}`, r ? r.p(`x_${i}_${j}`) : 0);
        }
      }
      const contradicting = pairs.filter(([i, j]) => (contra.get(`${i}_${j}`) ?? 0) >= T.CONTRA);
      trace.deliberation.contradictions = contradicting.map(([i, j]) => ({ a: pool[i - 1].messageId, b: pool[j - 1].messageId, p: contra.get(`${i}_${j}`)! }));
      trace.deliberation.unavailable = unavailable;

      // domains: from the contradicting claims (chat) or the situation (ruling)
      let domains: string[] = [];
      const needFrame = contradicting.length > 0 || mode !== "chat";
      if (needFrame) {
        const frameState = { input: req.input, conflicting_claims: mode === "chat" ? [...new Set(contradicting.flat())].map((n) => pool[n - 1].claim) : [req.situation?.text ?? req.input] };
        const fr = await tryDecide(providers.decider, frameState, CONCLAVE_FRAME(Object.keys(cfg.domains)), "conclave_frame", cycleId);
        if (fr) {
          const ps = Object.keys(cfg.domains).map((d) => ({ d, p: fr.p(`d_${d}`) }));
          domains = ps.filter((x) => x.p >= 0.5).map((x) => x.d);
          if (!domains.length) domains = [ps.reduce((a, b) => (b.p > a.p ? b : a)).d];
        } else domains = Object.keys(cfg.domains);
      }
      trace.deliberation.domains = domains;
      const rel = (voice: string) => relevanceWeight(cfg.relevance[voice] ?? {}, domains);
      const kappaPairs = pairs.map(([i, j]) => ({
        alphaI: rel(pool[i - 1].voice) * pool[i - 1].confidence,
        alphaJ: rel(pool[j - 1].voice) * pool[j - 1].confidence,
        contradicts: (contra.get(`${i}_${j}`) ?? 0) >= T.CONTRA,
        cI: pool[i - 1].confidence,
        cJ: pool[j - 1].confidence,
      }));
      const kappa = contradicting.length ? conflictKappa(kappaPairs) : 0;
      trace.deliberation.kappa = kappa;

      if ((contradicting.length > 0 || mode !== "chat") && shouldConvene({ kappa, pairs: kappaPairs, tauKappa: cfg.thresholds.tau_kappa, mode })) {
        entities.push("CONCLAVE_MODERATOR");
        const optionSources = mode === "chat" ? [...new Set(contradicting.flat())].sort((a, b) => a - b).map((n) => pool[n - 1]) : [];
        const options = mode === "chat" ? buildOptions(cycleId.slice(-8), optionSources.map((w) => ({ voice: w.voice, claim: w.claim, evidence_refs: w.evidence.map((e) => e.chunkId), uncertainty: w.uncertainty }))) : situationOptions(req.situation?.options ?? []);
        // two moderated rounds (the moderator frames and collates; ballots are decisions, not text)
        const entries = optionSources.map((w) => ({ voice: w.voice, text: w.claim }));
        const roundSummaries: Record<string, string> = {};
        let frame = req.situation?.text ?? req.input;
        const rounds: unknown[] = [];
        for (const round of [1, 2] as const) {
          try {
            const r = await providers.llm.generate("CONCLAVE_ROUND", { round, question: frame, input: req.input, entries }, Schemas.CONCLAVE_ROUND, { ...promptSettings("CONCLAVE_ROUND"), purpose: "conclave_round", cycleId });
            if (round === 1 && r.data.frame) frame = r.data.frame;
            if (round === 2) for (const e of r.data.entries) roundSummaries[e.voice] = e.steelman ? `${e.text} (steelman: ${e.steelman})` : e.text;
            rounds.push(r.data);
            await this.publish("procedure.conclave", "task/deliberation", "status.updated", "deliberate", { kind: "conclave_round", round, frame, entries: r.data.entries }, cycleId, r.model);
          } catch (e) {
            if (!(e instanceof GenerationError)) throw e;
            rounds.push({ round, error: "generation failed" });
          }
        }
        // ballots: one BALLOT decision per Core Voice with a rated claim this cycle; others abstain
        const optIds = options.map((o) => o.option_id);
        const voters = whispers.filter((w) => !w.numbersUnavailable);
        const ballots: Ballot[] = [];
        for (const w of voters) {
          const r = await tryDecide(
            providers.decider,
            { question: frame, voice: { name: w.voice, faculty: w.faculty, mentor_principles: [] }, round_summaries: roundSummaries, options: Object.fromEntries(options.map((o, k) => [`o_${k + 1}`, o.claim])) },
            BALLOT(w.voice, w.faculty, options.map((_, k) => k + 1)),
            "ballot",
            cycleId,
          );
          ballots.push({
            voice: w.voice,
            w: rel(w.voice),
            c: w.confidence,
            scores: r ? Object.fromEntries(options.map((o, k) => [o.option_id, r.p(`o_${k + 1}`)])) : {},
            abstained: r === null,
          });
        }
        const outcome = aggregate({
          optionIds: optIds,
          ballots,
          params: { tauPass: cfg.thresholds.tau_pass, tauMargin: cfg.thresholds.tau_margin, qMin: cfg.thresholds.q_min, antiEchoMinGuilds: cfg.conclave.anti_echo_min_guilds, guilds: cfg.guilds },
          reasons: roundSummaries,
        });
        const run = await db.conclaveRun.upsert({
          where: { cycleId },
          create: {
            cycleId,
            question: frame,
            domains: JSON.stringify(domains),
            options: JSON.stringify(options),
            rounds: JSON.stringify(rounds),
            ballots: JSON.stringify(Object.fromEntries(ballots.map((b) => [b.voice, b.abstained ? { abstained: true } : b.scores]))),
            weights: JSON.stringify(outcome.weights),
            totals: JSON.stringify(outcome.totals),
            kappa,
            winner: outcome.winner,
            margin: outcome.margin,
            decision: outcome.decision,
            dissent: JSON.stringify(outcome.dissent),
            guildsInWinningCoalition: JSON.stringify(outcome.guildsInWinningCoalition),
          },
          update: {},
          select: { id: true },
        });
        trace.conclaveId = run.id;
        conclave = { options, outcome, ballots };
        // a decided Conclave replaces the losing options' claims in the coalition with the winner's
        if (outcome.decision === "PASS" && outcome.winner && mode === "chat") {
          const winnerOpt = options.find((o) => o.option_id === outcome.winner)!;
          const loserClaims = new Set(options.filter((o) => o.option_id !== outcome.winner).map((o) => o.claim));
          const winnerW = whispers.find((w) => w.claim === winnerOpt.claim);
          coalition = coalition.filter((w) => !loserClaims.has(w.claim));
          if (winnerW && !coalition.includes(winnerW)) coalition.unshift(winnerW);
        }
      }

      // WITNESS principal audit: post-integration, never in the fan-out
      entities.push("WITNESS");
      const markers = await this.state.openConflictMarkers();
      const flagsState = {
        input: req.input,
        whispers: whispers.map((w) => ({ voice: w.voice, claim: w.claim, c: w.confidence, moral: w.moralFlag })),
        awareness: trace.awareness.text,
        excluded: trace.awareness.excluded,
        decayed: trace.attention.decayed,
        conclave: conclave ? { winner: conclave.outcome.winner, decision: conclave.outcome.decision, dissent: conclave.outcome.dissent } : null,
        open_conflict_markers: markers.map((m) => m.body),
      };
      const wf = await tryDecide(providers.decider, flagsState, WITNESS_FLAGS(), "witness_flags", cycleId);
      const flags: Record<string, number> = {};
      type Rec = "continue" | "redirect" | "reflect";
      let recommendation = "continue" as Rec;
      if (wf) {
        for (const f of ["circular", "unchallenged", "overconfident", "flooding", "moral_dropped", "bias_label"]) flags[f] = wf.p(f);
        const pr = wf.probs("recommend");
        recommendation = wf.choice("recommend") as Rec;
        if (recommendation === "reflect" && (pr.reflect ?? 0) < T.REFLECT) recommendation = "redirect";
      }
      let audit = { quality: "", notConsidering: "", note: "" };
      try {
        const r = await providers.llm.generate(
          "WITNESS_AUDIT",
          { whispers: flagsState.whispers, awareness: trace.awareness.text, selected: trace.awareness.selected, excluded: trace.awareness.excluded, decayed: trace.attention.decayed, conclave: flagsState.conclave, conflictMarkers: flagsState.open_conflict_markers, flags, recommend: recommendation, shared },
          Schemas.WITNESS_AUDIT,
          { ...promptSettings("WITNESS_AUDIT"), purpose: "witness_audit", cycleId },
        );
        audit = r.data;
      } catch (e) {
        if (!(e instanceof GenerationError)) throw e;
      }
      trace.witness = { ran: true, flags, recommendation, ...audit, reflectRan: trace.witness.reflectRan, unavailable: wf === null };
      await this.publish("core.witness", "task/deliberation", "objection.raised", "deliberate", { kind: "audit", flags, recommendation, ...audit }, cycleId, "witness");
      auditNote = recommendation === "redirect" ? audit.note : "";

      if (recommendation === "reflect" && allowReflect) {
        // one REFLECT loop: re-run P2–P4 with the audit note (max 1 per cycle)
        trace.witness.reflectRan = true;
        this.bus.allowReflectRound();
        await whisper(audit.note || audit.notConsidering);
        await attend();
        await deliberate(false);
        trace.witness.reflectRan = true;
      }
      return entities;
    };

    // ---------------- P5 GOVERN
    const govern = async (): Promise<string[]> => {
      const logos = whispers.find((w) => w.voice === "LOGOS");
      const res = await arbitrate(providers.decider, providers.llm, {
        cycleId,
        input: req.input,
        awareness: trace.awareness.text,
        coalition: coalition.map((w) => ({ id: w.messageId, claim: w.claim })),
        conclave: conclave ? { winner: conclave.outcome.winner ? conclave.options.find((o) => o.option_id === conclave!.outcome.winner)?.claim ?? null : null, decision: conclave.outcome.decision, dissent: conclave.outcome.dissent } : null,
        audit: trace.witness.ran ? { flags: trace.witness.flags, recommend: trace.witness.recommendation } : null,
        principles,
        commitments,
        logosConfidence: logos ? logos.confidence : null,
      });
      trace.arbiter = {
        decision: res.decision,
        humility: res.humility,
        principlesChecked: res.principlesChecked,
        commitmentsChecked: res.commitmentsChecked,
        guidance: res.guidance,
        overrides: res.overrides,
        unavailable: res.unavailable,
      };
      arbiterGuidance = res.guidance ?? (res.humility ? "State any uncertainty plainly." : "");
      await this.publish("governance.symbiont_prime", "task/governance", "decision.published", "govern", { kind: "arbitration", decision: res.decision, humility: res.humility, guidance: res.guidance ?? null, overrides: res.overrides }, cycleId, "decision-layer");
      return ["SYMBIONT_PRIME"];
    };

    // ---------------- P6 COMPOSE
    const compose = async (): Promise<string[]> => {
      const approved = Object.fromEntries(coalition.map((w) => [w.messageId, w.claim]));
      const approvedEvidence = coalition.flatMap((w) => w.evidence);
      const winner = conclave?.outcome.winner ? conclave.options.find((o) => o.option_id === conclave!.outcome.winner)?.claim : undefined;
      const baseVars = {
        awareness: trace.awareness.text,
        coalition: approved,
        evidence: approvedEvidence,
        conclave: conclave ? { winner, decision: conclave.outcome.decision, dissent: conclave.outcome.dissent.map((d) => d.voice) } : undefined,
        guidance: arbiterGuidance,
        auditNote,
        register: parse.register,
        verdict: trace.arbiter.decision,
        honestyNote,
        shared,
      };
      const gen = async (extra: Record<string, unknown>) =>
        (await providers.llm.generate("LEXICON_COMPOSE", { ...baseVars, ...extra }, Schemas.LEXICON_COMPOSE, { ...promptSettings("LEXICON_COMPOSE"), purpose: "lexicon_compose", cycleId })).data;
      let draft = await gen({});
      trace.compose.draft = draft.text;
      let check = await checkFaithfulness(providers.decider, { cycleId, approved, guidance: arbiterGuidance, text: draft.text });
      let regenerated = false;
      const failing = check.sentences.filter((s) => !s.faithful).map((s) => s.sentence);
      if (failing.length) {
        regenerated = true;
        draft = await gen({ failingSentences: failing });
        check = await checkFaithfulness(providers.decider, { cycleId, approved, guidance: arbiterGuidance, text: draft.text });
      }
      const kept = check.sentences.filter((s) => s.faithful).map((s) => s.sentence);
      let text = kept.join(" ");
      // any quote in the output must verify against approved evidence, else it is removed
      let quotesRemoved = 0;
      for (const q of draft.quotes) {
        const ev = approvedEvidence.find((e) => e.chunkId === q.chunkId);
        if (!ev || ev.quote !== q.quote) {
          quotesRemoved++;
          text = text.split(q.quote).join("").replace(/\s+/g, " ").trim();
          await this.d.ledger.record({ kind: "quote.rejected", cycleId, subjectType: "voice", subjectId: "LEXICON", payload: { promptId: "LEXICON_COMPOSE", chunkId: q.chunkId, reason: ev ? "not_approved_quote" : "chunk_not_approved", quote: q.quote.slice(0, 200) } });
        }
      }
      output = text || "(No sentence of the draft passed the faithfulness check.)";
      trace.compose = {
        draft: trace.compose.draft,
        faithfulness: check.sentences.map((s) => ({ sentence: s.sentence, p: s.p, kept: s.faithful })),
        regenerated,
        quotesRemoved,
        unavailable: check.unavailable,
      };
      // when regeneration happened, also record first-draft sentences that were dropped
      if (regenerated)
        for (const f of failing)
          if (!trace.compose.faithfulness.some((x) => x.sentence === f)) trace.compose.faithfulness.unshift({ sentence: f, p: null, kept: false });
      await this.publish("core.lexicon", "user/output/draft", "proposal.submitted", "compose", { kind: "draft", text: output, regenerated }, cycleId, "lexicon");
      return ["LEXICON", "TIRELESS"];
    };

    // ---------------- P7 REFLECT
    const reflect = async (): Promise<string[]> => {
      trace.reflect.ran = true;
      const promote = mode !== "calibration"; // calibration cycles never change the Hive
      const gen = async <K extends "MNEME_CONSOLIDATE" | "MIRROR_DELTA" | "ADAPT_LESSON" | "HERITAGE_CANON">(id: K, vars: Record<string, unknown>): Promise<z.infer<(typeof Schemas)[K]> | null> => {
        try {
          const schema = Schemas[id] as unknown as z.ZodType<z.infer<(typeof Schemas)[K]>>;
          return (await providers.llm.generate(id, { ...vars, shared }, schema, { ...promptSettings(id), purpose: id.toLowerCase(), cycleId })).data;
        } catch (e) {
          if (e instanceof GenerationError) return null;
          throw e;
        }
      };
      const cycleSummary = { input: req.input, output, awareness: trace.awareness.text, verdict: trace.arbiter.decision };

      // MNEME: episode memory (hive scope when verified, else this session)
      const ep = await gen("MNEME_CONSOLIDATE", { cycle: cycleSummary, input: req.input, output, memories: memories.map((m) => m.body) });
      if (ep) {
        const env = await this.publish("core.mneme", "memory/episode/propose", "memory.candidate", "reflect", { kind: "episode", ...ep }, cycleId, "mneme");
        if (promote) {
          const id = await this.state.write({ scope: ep.certainty === "verified" ? "hive" : "project", ownerEntity: "core.mneme", kind: "episode", body: ep.summary, certainty: ep.certainty, createdCycle: cycleNo, sessionId, provenance: { cycleId, messageId: env.message_id } });
          trace.reflect.memory.push(id);
        }
      }

      // MIRROR: Self-Model delta; goals must trace to approved principles
      const delta = await gen("MIRROR_DELTA", { selfModel, summary: JSON.stringify(cycleSummary), principles: principles.map((p) => p.text) });
      if (delta) {
        await this.publish("core.mirror", "memory/selfmodel/delta", "selfmodel.delta", "reflect", { kind: "selfmodel_delta", ...delta }, cycleId, "mirror");
        let reason: string | undefined;
        if (delta.addGoals.length) {
          if (!principles.length) reason = "goals added but no constitution principle is approved yet";
          else {
            const g = await tryDecide(providers.decider, { principles: principles.map((p) => p.text), goals: Object.fromEntries(delta.addGoals.map((x, i) => [`g_${i + 1}`, x.text])) }, PROMOTE_GOAL(delta.addGoals.map((_, i) => i + 1)), "promote_goal", cycleId);
            if (!g) reason = "goal traceability unavailable";
            else if (delta.addGoals.some((_, i) => g.p(`g_${i + 1}`) < T.TRACE)) reason = "a goal does not trace to an approved principle";
          }
        }
        if (!reason) {
          const grab = await tryDecide(providers.decider, { proposal: JSON.stringify(delta), trigger: req.input }, AUTHORITY_GRAB(), "authority_grab", cycleId);
          if (grab && grab.p("grab") >= 0.5) reason = "proposal grants the Hive new authority without an outside request";
        }
        if (reason) {
          if (promote) trace.reflect.conflictMarkers.push(await this.state.writeConflictMarker(`Self-Model delta not promoted: ${reason}`, cycleNo, sessionId, { cycleId }));
          trace.reflect.selfModel = { promoted: false, reason };
          if (promote) await db.selfModelVersion.create({ data: { version: (await this.nextSelfModelVersion()), body: JSON.stringify(delta), deltaFrom: sm?.version ?? null, cycleId, promoted: false, rejectReason: reason } });
        } else if (promote) {
          const version = await this.nextSelfModelVersion();
          const body = {
            ...selfModel,
            ...(delta.identity ? { identity: delta.identity } : {}),
            ...(delta.hats ? { hats: delta.hats } : {}),
            current_goals: [...(((selfModel as { current_goals?: unknown[] }).current_goals ?? []) as unknown[]).filter((g) => !delta.dropGoals.includes(String((g as { text?: string }).text ?? g))), ...delta.addGoals],
            recent_growth: delta.recentGrowth ?? (selfModel as { recent_growth?: string }).recent_growth ?? "",
            open_uncertainties: delta.openUncertainties,
            contradictions: delta.contradictions,
          };
          await db.selfModelVersion.create({ data: { version, body: JSON.stringify(body), deltaFrom: sm?.version ?? null, cycleId, promoted: true } });
          trace.reflect.selfModel = { promoted: true, version };
        } else trace.reflect.selfModel = { promoted: false, reason: "calibration cycle" };
      }

      // ADAPT: lesson and checkable predictions
      const lesson = await gen("ADAPT_LESSON", { predictions: [], cycle: cycleSummary });
      if (lesson) {
        await this.publish("core.adapt", "task/analysis", "proposal.submitted", "reflect", { kind: "lesson", ...lesson }, cycleId, "adapt");
        if (lesson.lesson) {
          trace.reflect.lesson = lesson.lesson;
          if (promote) await this.state.write({ scope: "project", ownerEntity: "core.adapt", kind: "lesson", body: lesson.lesson, certainty: "inferred", createdCycle: cycleNo, sessionId, provenance: { cycleId } });
        }
        if (promote)
          for (const p of lesson.predictions) {
            const row = await db.hivePrediction.create({ data: { cycleId, text: p.text, proposedBy: "ADAPT", mentorRefs: JSON.stringify(p.mentorIds), checkInAt: new Date(Date.now() + p.horizonDays * 86_400_000) }, select: { id: true } });
            trace.reflect.predictions.push(row.id);
          }
      }

      // HERITAGE: canon candidate; promoted only after surviving testing across ≥ 2 cycles
      const canon = await gen("HERITAGE_CANON", { cycle: cycleSummary, lessons: [] });
      if (canon?.candidate) {
        await this.publish("core.heritage", "task/analysis", "canon.candidate", "reflect", { kind: "canon", ...canon }, cycleId, "heritage");
        const survives = canon.evidenceCycles.length >= 2;
        if (survives && promote) await this.state.write({ scope: "hive", ownerEntity: "core.heritage", kind: "canon", body: canon.candidate, certainty: "inferred", createdCycle: cycleNo, sessionId, provenance: { cycleId, evidenceCycles: canon.evidenceCycles } });
        trace.reflect.canon = { promoted: survives && promote, candidate: canon.candidate };
      }

      if (promote) await this.state.decay(cfg.memory.decay_gamma);
      return ["MNEME", "MIRROR", "ADAPT", "HERITAGE"];
    };

    // ---------------- orchestration: manager or code chooses the next allowed phase
    const ran = new Set<PhaseId>();
    const progress = () =>
      [...ran]
        .map((id) => {
          const p = PHASES[id];
          const detail =
            id === "P1" ? `affect ${trace.affect.dominant}, arousal ${trace.affect.arousal.toFixed(2)}${trace.honestyClauseFired ? ", honesty probe fired" : ""}`
            : id === "P2" ? `${trace.whispers.length} claims, ${trace.passes.length} passes, ${trace.whispers.filter((w) => w.moralFlag).length} moral flags`
            : id === "P3" ? `awareness: ${trace.awareness.text.slice(0, 160)}`
            : id === "P4" ? `${trace.deliberation.contradictions.length} contradictions, kappa ${trace.deliberation.kappa.toFixed(2)}${trace.conclaveId ? `, Conclave ${conclave?.outcome.decision}` : ""}, WITNESS ${trace.witness.recommendation}`
            : id === "P5" ? `arbiter ${trace.arbiter.decision}`
            : id === "P6" ? `reply composed (${output.length} chars)`
            : "reflected";
          return `${id} ${p.name}: ${detail}`;
        })
        .join("\n");
    const phaseFns: Record<PhaseId, () => Promise<string[]>> = {
      P1: perceive,
      P2: () => whisper(),
      P3: attend,
      P4: () => deliberate(true),
      P5: govern,
      P6: compose,
      P7: reflect,
    };

    let status: "done" | "error" = "done";
    try {
      for (let step = 0; ; step++) {
        const forced = step >= cfg.orchestration.max_manager_steps;
        const choice = forced
          ? await chooseNext({ mode: "code", llm: providers.manager, ran, input: req.input, cycleMode: mode, progress: "", cycleId })
          : await chooseNext({ mode: orchestrationMode, llm: providers.manager, ran, input: req.input, cycleMode: mode, progress: progress(), cycleId }).catch((e) => {
              throw new CycleError("orchestration", e);
            });
        trace.orchestration.steps.push({ phase: choice.next, by: forced ? "code" : choice.by, allowed: choice.allowed, reason: forced ? "max manager steps reached" : choice.reason });
        if (choice.next === "FINISH") break;
        await runPhase(choice.next, phaseFns[choice.next]);
        ran.add(choice.next);
      }
    } catch (e) {
      status = "error";
      const ce = e instanceof CycleError ? e : new CycleError("unknown", e);
      trace.error = { phase: ce.phase, name: ce.name, message: ce.message.slice(0, 500) };
    }

    const costUsd = providers.meter.spentUsd - spentAt0;
    await db.cycle.update({
      where: { id: cycleId },
      data: {
        output: status === "done" ? output : null,
        awareness: trace.awareness.text || null,
        verdict: trace.phases.P5.ran ? trace.arbiter.decision : null,
        status,
        trace: JSON.stringify(trace),
        costUsd,
        latencyMs: Date.now() - t0,
      },
    });
    return { cycleId, cycleNo, status, output: status === "done" ? output : "", trace, conclave };
  }

  private async nextSelfModelVersion(): Promise<number> {
    const last = await this.d.db.selfModelVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    return (last?.version ?? 0) + 1;
  }
}

/** Unique id for ad-hoc sessions (REPL, eval). */
export const newId = () => randomUUID();
