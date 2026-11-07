import "server-only";
import { z } from "zod";

/** CycleTrace (docs/DATA_MODEL.md), stored in Cycle.trace, plus orchestration and error records. */

const PhaseRecord = z.object({ ran: z.boolean(), ms: z.number(), costUsd: z.number(), entities: z.array(z.string()) });
const P = ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7"] as const;

export const TraceWhisperSchema = z.object({
  messageId: z.string(),
  voice: z.string(),
  claim: z.string(),
  confidence: z.number(),
  salience: z.number(),
  valence: z.number(),
  evidence: z.array(z.object({ chunkId: z.string(), quote: z.string(), mentorId: z.string() })),
  rejectedEvidence: z.number(),
  advisory: z.boolean(),
  endorsedBy: z.string().nullable(),
  moralFlag: z.boolean(),
  numbersUnavailable: z.boolean(),
  uncertainty: z.string(),
  /** mentors whose writings formed this Voice's attribute lens this cycle (empty = no lens) */
  lens: z.array(z.string()),
});
export type TraceWhisper = z.infer<typeof TraceWhisperSchema>;

export const CycleTraceSchema = z.object({
  mock: z.boolean(),
  mode: z.enum(["chat", "ruling", "calibration"]),
  phases: z.object(Object.fromEntries(P.map((p) => [p, PhaseRecord])) as Record<(typeof P)[number], typeof PhaseRecord>),
  orchestration: z.object({
    mode: z.enum(["manager", "code"]),
    managerModel: z.string().nullable(),
    steps: z.array(z.object({ phase: z.string(), by: z.enum(["manager", "code", "fallback"]), allowed: z.array(z.string()), reason: z.string() })),
  }),
  affect: z.object({ valence: z.number(), arousal: z.number(), dominant: z.string(), unavailable: z.boolean() }),
  memories: z.array(z.object({ id: z.string(), certainty: z.string(), priority: z.number(), body: z.string() })),
  parse: z.object({ intent: z.string(), subtext: z.string(), register: z.string() }),
  whispers: z.array(TraceWhisperSchema),
  passes: z.array(z.string()),
  attention: z.object({
    scores: z.record(z.string(), z.number()),
    shortlist: z.array(z.string()),
    bypass: z.array(z.string()),
    decayed: z.array(z.string()),
    rejectedSelections: z.array(z.string()),
  }),
  awareness: z.object({ text: z.string(), selected: z.array(z.string()), excluded: z.array(z.object({ id: z.string(), reason: z.string() })) }),
  deliberation: z.object({
    kappa: z.number(),
    contradictions: z.array(z.object({ a: z.string(), b: z.string(), p: z.number() })),
    domains: z.array(z.string()),
    unavailable: z.boolean(),
  }),
  conclaveId: z.string().optional(),
  /** dominant mentor's final call (owner decision 2026-11-06); absent when no dominant mentor is set */
  finalCall: z
    .object({
      mentorId: z.string(),
      mentorName: z.string(),
      choice: z.string().nullable(),
      voteWinner: z.string().nullable(),
      overruledVote: z.boolean(),
      soundness: z.record(z.string(), z.number()),
      reason: z.string(),
      skipped: z.string().nullable(),
      unavailable: z.boolean(),
    })
    .optional(),
  witness: z.object({
    ran: z.boolean(),
    flags: z.record(z.string(), z.number()),
    recommendation: z.enum(["continue", "redirect", "reflect"]),
    quality: z.string(),
    notConsidering: z.string(),
    note: z.string(),
    reflectRan: z.boolean(),
    /** why a REFLECT loop ran: WITNESS recommended it, or it was mandated (ego audit / old CONFLICT marker) */
    reflectReason: z.enum(["witness", "ego_audit", "conflict_marker"]).nullable(),
    unavailable: z.boolean(),
  }),
  arbiter: z.object({
    decision: z.enum(["PASS", "AMEND", "ASK_USER"]),
    humility: z.boolean(),
    principlesChecked: z.array(z.string()),
    commitmentsChecked: z.array(z.string()),
    guidance: z.string().optional(),
    overrides: z.array(z.string()),
    commitmentConflicts: z.array(z.string()),
    commitmentsBroken: z.array(z.object({ id: z.string(), reason: z.string() })),
    unavailable: z.boolean(),
  }),
  compose: z.object({
    draft: z.string(),
    faithfulness: z.array(z.object({ sentence: z.string(), p: z.number().nullable(), kept: z.boolean() })),
    regenerated: z.boolean(),
    quotesRemoved: z.number(),
    mentorVoiceDropped: z.number(),
    /** quotes kept in the output: each matches an approved, verified whisper quote */
    quotes: z.array(z.object({ chunkId: z.string(), quote: z.string(), mentorId: z.string() })),
    unavailable: z.boolean(),
  }),
  reflect: z.object({
    ran: z.boolean(),
    selfModel: z.object({ promoted: z.boolean(), reason: z.string().optional(), version: z.number().optional() }),
    memory: z.array(z.string()),
    lesson: z.string().optional(),
    canon: z.object({ promoted: z.boolean(), candidate: z.string().optional() }),
    predictions: z.array(z.string()),
    conflictMarkers: z.array(z.string()),
    commitmentsMade: z.array(z.string()),
    authorityGrab: z.boolean(),
    contradictionsRecorded: z.number(),
    resolvedMarkers: z.array(z.string()),
  }),
  egoAudit: z.object({ ran: z.boolean(), trigger: z.enum(["periodic", "on_demand"]).nullable(), mandate: z.boolean(), summary: z.string() }),
  coherence: z.object({
    cIntra: z.number().nullable(),
    cInter: z.number().nullable(),
    perVoiceDrift: z.record(z.string(), z.number()),
    flags: z.array(z.string()),
    unavailable: z.boolean(),
  }),
  /** hat taxonomy (sent2 v1.3 §3.1) of the entities that ran this cycle */
  hats: z.array(z.object({ entity: z.string(), type: z.string(), revisableBy: z.array(z.string()) })),
  honestyClauseFired: z.boolean(),
  /** M9: advisors that activated this cycle, their route, the ENDORSE result, and where an endorsed advisory went */
  advisors: z
    .array(
      z.object({
        name: z.string(),
        phase: z.enum(["whisper", "deliberate", "compose", "reflect"]),
        via: z.array(z.string()),
        trigger: z.string().nullable(),
        claim: z.string(),
        passed: z.boolean(),
        endorsedBy: z.string().nullable(),
        probabilities: z.record(z.string(), z.number()).nullable(),
        enteredAs: z.enum(["coalition", "compose", "reflect"]).nullable(),
        detail: z.unknown().optional(),
      }),
    )
    .default([]),
  /** M9: signals emitted in P7 (tension/serves per principle, dissent per Voice) */
  signals: z.array(z.object({ type: z.string(), subjectType: z.string(), subjectId: z.string() })).default([]),
  /** TEST FAULTS planted by live eval (lib/hive/faults.ts); empty in every real cycle */
  plantedFaults: z.array(z.string()).default([]),
  error: z.object({ phase: z.string(), name: z.string(), message: z.string() }).optional(),
});
export type CycleTrace = z.infer<typeof CycleTraceSchema>;

export function emptyTrace(mode: CycleTrace["mode"], mock: boolean, orchestrationMode: "manager" | "code", managerModel: string | null): CycleTrace {
  const phase = () => ({ ran: false, ms: 0, costUsd: 0, entities: [] as string[] });
  return {
    mock,
    mode,
    phases: { P0: phase(), P1: phase(), P2: phase(), P3: phase(), P4: phase(), P5: phase(), P6: phase(), P7: phase() },
    orchestration: { mode: orchestrationMode, managerModel, steps: [] },
    affect: { valence: 0, arousal: 0, dominant: "calm", unavailable: false },
    memories: [],
    parse: { intent: "", subtext: "", register: "" },
    whispers: [],
    passes: [],
    attention: { scores: {}, shortlist: [], bypass: [], decayed: [], rejectedSelections: [] },
    awareness: { text: "", selected: [], excluded: [] },
    deliberation: { kappa: 0, contradictions: [], domains: [], unavailable: false },
    witness: { ran: false, flags: {}, recommendation: "continue", quality: "", notConsidering: "", note: "", reflectRan: false, reflectReason: null, unavailable: false },
    arbiter: { decision: "PASS", humility: false, principlesChecked: [], commitmentsChecked: [], overrides: [], commitmentConflicts: [], commitmentsBroken: [], unavailable: false },
    compose: { draft: "", faithfulness: [], regenerated: false, quotesRemoved: 0, mentorVoiceDropped: 0, quotes: [], unavailable: false },
    reflect: { ran: false, selfModel: { promoted: false }, memory: [], canon: { promoted: false }, predictions: [], conflictMarkers: [], commitmentsMade: [], authorityGrab: false, contradictionsRecorded: 0, resolvedMarkers: [] },
    egoAudit: { ran: false, trigger: null, mandate: false, summary: "" },
    coherence: { cIntra: null, cInter: null, perVoiceDrift: {}, flags: [], unavailable: false },
    hats: [],
    honestyClauseFired: false,
    advisors: [],
    signals: [],
    plantedFaults: [],
  };
}
