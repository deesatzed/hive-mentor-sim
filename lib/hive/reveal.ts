import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { effectiveN, kappa } from "@/lib/council/councilMetrics";
import type { Decider } from "@/lib/council/providers/decisions";
import type { Ballot } from "./conclave";
import { tryDecide } from "./decide";
import { activeFormation } from "./formation";
import type { Hive } from "./orchestrator";
import { CONSTITUTION_RULING } from "./questions";

/**
 * Reveal: declared vs. revealed character (docs/PRODUCT_SPEC.md §5, ARCHITECTURE.md "Ruling mode").
 * The Hive rules on every dilemma in ruling mode (one heartbeat per dilemma; the Conclave winner is the
 * ruling); each Voice's top-scored ballot option and the constitution's predicted ruling are stored in
 * `HiveRuling`. Comparisons count only dilemmas where the mentor has evidence (an answered MentorAnswer
 * with a choice), and an agreement rate is shown only when n ≥ MIN_N. Wording rule (MENTOR_CORPUS.md):
 * "the Hive's rulings matched this mentor's evidenced choices k of n times", never "thinks like".
 */

export const MIN_N = 8;

export type Choices = Map<string, string>; // dilemma id → option id

export interface Agreement {
  n: number;
  matches: number;
  /** κ-corrected agreement (chance = 1 / mean option count), clipped to [0, 1]; null below MIN_N */
  kappa: number | null;
  enough: boolean;
}

const norm = (x: string) => x.trim().toLowerCase();

/** Agreement between two choice maps over the dilemmas both have. */
export function agreement(a: Choices, b: Choices, optionCount: Map<string, number>): Agreement {
  const shared = [...a.keys()].filter((k) => b.has(k));
  const matches = shared.filter((k) => norm(a.get(k)!) === norm(b.get(k)!)).length;
  const enough = shared.length >= MIN_N;
  return { n: shared.length, matches, kappa: enough ? kappa(lower(a), lower(b), optionCount).kappa : null, enough };
}

function lower(m: Choices): Choices {
  return new Map([...m].map(([k, v]) => [k, norm(v)]));
}

/** A Voice's top option against each of its mentors' evidenced choices, pooled over (dilemma, mentor) pairs. */
export function voiceVsMentors(voiceTop: Choices, mentors: string[], mentorChoices: Map<string, Choices>): { n: number; matches: number; enough: boolean } {
  let n = 0;
  let matches = 0;
  for (const m of mentors) {
    const mc = mentorChoices.get(m);
    if (!mc) continue;
    for (const [d, opt] of voiceTop) {
      const c = mc.get(d);
      if (c === undefined) continue;
      n++;
      if (norm(c) === norm(opt)) matches++;
    }
  }
  return { n, matches, enough: n >= MIN_N };
}

/** A Voice's top-scored option; null when it abstained or its best score is tied. */
export function voiceTop(b: Ballot, optionIds: string[]): string | null {
  if (b.abstained) return null;
  const scored = optionIds.filter((o) => b.scores[o] !== undefined);
  if (!scored.length) return null;
  const best = Math.max(...scored.map((o) => b.scores[o]));
  const top = scored.filter((o) => b.scores[o] === best);
  return top.length === 1 ? top[0] : null;
}

/**
 * Suggestions for one Voice, among active mentors not already assigned to it:
 *   revealed — highest agreement with the Voice's own top options (n ≥ MIN_N only);
 *   wildcard — maximizes mentor N_eff of (current mentors + candidate), i.e. adds the most new perspective;
 *              distinct from the revealed pick. Ties break by mentor id.
 */
export function suggest(args: {
  voiceTop: Choices;
  current: string[];
  candidates: string[];
  mentorChoices: Map<string, Choices>;
  optionCount: Map<string, number>;
}): { revealed: { mentorId: string; agreement: Agreement } | null; wildcard: { mentorId: string; nEff: number } | null } {
  const cands = [...args.candidates].filter((c) => !args.current.includes(c) && args.mentorChoices.has(c)).sort();
  let revealed: { mentorId: string; agreement: Agreement } | null = null;
  for (const c of cands) {
    const a = agreement(args.voiceTop, args.mentorChoices.get(c)!, args.optionCount);
    if (!a.enough) continue;
    if (!revealed || a.matches / a.n > revealed.agreement.matches / revealed.agreement.n) revealed = { mentorId: c, agreement: a };
  }
  let wildcard: { mentorId: string; nEff: number } | null = null;
  for (const c of cands) {
    if (c === revealed?.mentorId) continue;
    const set = new Map([...args.current, c].filter((m) => args.mentorChoices.has(m)).map((m) => [m, args.mentorChoices.get(m)!]));
    const nEff = effectiveN(set, args.optionCount).nEff;
    if (!wildcard || nEff > wildcard.nEff + 1e-12) wildcard = { mentorId: c, nEff };
  }
  return { revealed, wildcard };
}

// ---------------------------------------------------------------- run

export interface RevealRunKey {
  formationVersion: number;
  constitutionVersion: number | null;
}

async function currentKey(db: PrismaClient): Promise<RevealRunKey & { principles: string[] }> {
  const f = await activeFormation(db);
  if (!f) throw new Error("no formation; seed the database first");
  const rows = await db.hivePrinciple.findMany({ where: { status: "approved" }, orderBy: { createdAt: "asc" } });
  return { formationVersion: f.version, constitutionVersion: rows.length ? Math.max(...rows.map((p) => p.version)) : null, principles: rows.map((p) => p.text) };
}

const keyLabel = (k: RevealRunKey) => `formation v${k.formationVersion}, constitution ${k.constitutionVersion === null ? "none" : `v${k.constitutionVersion}`}`;

/**
 * Runs (or resumes) Reveal for the current formation and constitution: every dilemma without a ruling
 * for this key gets one ruling-mode heartbeat. A cycle that ends in error stores no ruling, so a resume
 * retries it. `limit` caps how many new dilemmas this call runs.
 */
export async function runReveal(args: {
  hive: Hive;
  db: PrismaClient;
  decider: Decider;
  limit?: number;
  onProgress?: (p: { done: number; total: number; situationId: string; status: string }) => void;
}): Promise<{ key: RevealRunKey; ran: number; errors: string[]; done: number; total: number }> {
  const { hive, db, decider } = args;
  const key = await currentKey(db);
  const dilemmas = await db.situation.findMany({ where: { setKey: "dilemma" }, orderBy: { id: "asc" } });
  const have = new Set((await db.hiveRuling.findMany({ where: { formationVersion: key.formationVersion, constitutionVersion: key.constitutionVersion }, select: { situationId: true } })).map((r) => r.situationId));
  const title = `Reveal (${keyLabel(key)})`;
  const session = (await db.hiveSession.findFirst({ where: { mode: "ruling", title }, select: { id: true } }))?.id ?? (await hive.createSession("ruling", title));
  let ran = 0;
  const errors: string[] = [];
  for (const d of dilemmas) {
    if (have.has(d.id)) continue;
    if (args.limit !== undefined && ran >= args.limit) break;
    const options = JSON.parse(d.options) as { id: string; text: string }[];
    const r = await hive.runCycle({ sessionId: session, input: d.text, mode: "ruling", situation: { id: d.id, text: d.text, options } });
    ran++;
    if (r.status !== "done" || !r.conclave) {
      errors.push(`${d.id}: ${r.trace.error?.phase ?? "no conclave"} ${r.trace.error?.message ?? ""}`.trim());
      args.onProgress?.({ done: have.size, total: dilemmas.length, situationId: d.id, status: "error" });
      continue;
    }
    const optionIds = options.map((o) => o.id);
    const perVoiceTop: Record<string, string> = {};
    for (const b of r.conclave.ballots) {
      const t = voiceTop(b, optionIds);
      if (t) perVoiceTop[b.voice] = t;
    }
    let constitutionChoice: string | null = null;
    if (key.principles.length) {
      const c = await tryDecide(decider, { principles: key.principles, dilemma: d.text }, CONSTITUTION_RULING(options), "constitution_ruling", r.cycleId);
      if (c) {
        // the mirror decision is part of this ruling's measured cost
        if (c.costUsd > 0) await db.cycle.update({ where: { id: r.cycleId }, data: { costUsd: { increment: c.costUsd } } });
        const p = c.probs("ruling");
        constitutionChoice = optionIds.reduce((best, o) => ((p[o] ?? 0) > (p[best] ?? 0) ? o : best), optionIds[0]);
      }
    }
    await db.hiveRuling.create({
      data: {
        situationId: d.id,
        cycleId: r.cycleId,
        choice: r.conclave.outcome.winner,
        constitutionChoice,
        perVoiceTop: JSON.stringify(perVoiceTop),
        formationVersion: key.formationVersion,
        constitutionVersion: key.constitutionVersion,
      },
    });
    have.add(d.id);
    args.onProgress?.({ done: have.size, total: dilemmas.length, situationId: d.id, status: "done" });
  }
  return { key: { formationVersion: key.formationVersion, constitutionVersion: key.constitutionVersion }, ran, errors, done: have.size, total: dilemmas.length };
}

// ---------------------------------------------------------------- results

export async function revealResults(db: PrismaClient) {
  const key = await currentKey(db);
  const formation = (await activeFormation(db))!;
  const dilemmas = await db.situation.findMany({ where: { setKey: "dilemma" }, orderBy: { id: "asc" } });
  const optionsOf = new Map(dilemmas.map((d) => [d.id, JSON.parse(d.options) as { id: string; text: string }[]]));
  const optionCount = new Map([...optionsOf].map(([k, v]) => [k, v.length]));
  const textOf = new Map(dilemmas.map((d) => [d.id, d.text]));
  const optText = (d: string, o: string | null) => (o === null ? "no ruling" : (optionsOf.get(d)?.find((x) => norm(x.id) === norm(o))?.text ?? o));

  const rulings = await db.hiveRuling.findMany({ where: { formationVersion: key.formationVersion, constitutionVersion: key.constitutionVersion }, orderBy: { situationId: "asc" } });
  const cycles = await db.cycle.findMany({ where: { id: { in: rulings.map((r) => r.cycleId) } }, select: { id: true, costUsd: true, trace: true } });
  const decisionOf = new Map((await db.conclaveRun.findMany({ where: { cycleId: { in: rulings.map((r) => r.cycleId) } }, select: { cycleId: true, decision: true } })).map((c) => [c.cycleId, c.decision]));
  const costUsd = cycles.reduce((s, c) => s + c.costUsd, 0);
  const mock = cycles.some((c) => (JSON.parse(c.trace) as { mock?: boolean }).mock === true);

  const hive: Choices = new Map(rulings.filter((r) => r.choice).map((r) => [r.situationId, r.choice!]));
  const voices = await db.voice.findMany({ where: { class: "core" }, orderBy: { id: "asc" }, select: { id: true, name: true } });
  const voiceTops = new Map<string, Choices>(voices.map((v) => [v.name, new Map()]));
  for (const r of rulings) for (const [v, o] of Object.entries(JSON.parse(r.perVoiceTop) as Record<string, string>)) voiceTops.get(v)?.set(r.situationId, o);

  const mentors = await db.mentor.findMany({ where: { active: true }, orderBy: { id: "asc" }, select: { id: true, name: true } });
  const nameOf = new Map(mentors.map((m) => [m.id, m.name]));
  const answers = await db.mentorAnswer.findMany({ where: { status: "answered", choice: { not: null }, questionKey: { startsWith: "DL-" }, mentorId: { in: mentors.map((m) => m.id) } } });
  const mentorChoices = new Map<string, Choices>(mentors.map((m) => [m.id, new Map()]));
  const evidenceOf = new Map<string, { chunkId: string; quote: string } | null>();
  for (const a of answers) {
    mentorChoices.get(a.mentorId)!.set(a.questionKey, a.choice!);
    const ev = JSON.parse(a.evidence) as { chunkId: string; quote: string }[];
    evidenceOf.set(`${a.mentorId}|${a.questionKey}`, ev[0] ? { chunkId: ev[0].chunkId, quote: ev[0].quote } : null);
  }

  const assignedCount = new Map<string, number>();
  for (const ms of Object.values(formation.assignments)) for (const m of ms) assignedCount.set(m, (assignedCount.get(m) ?? 0) + 1);
  const cycleOf = new Map(rulings.map((r) => [r.situationId, r.cycleId]));

  const hiveVsMentors = mentors
    .map((m) => {
      const a = agreement(hive, mentorChoices.get(m.id)!, optionCount);
      const items = [...hive.keys()]
        .filter((d) => mentorChoices.get(m.id)!.has(d))
        .map((d) => ({ situationId: d, text: textOf.get(d)!, hive: optText(d, hive.get(d)!), mentor: optText(d, mentorChoices.get(m.id)!.get(d)!), match: norm(hive.get(d)!) === norm(mentorChoices.get(m.id)!.get(d)!), cycleId: cycleOf.get(d)!, evidence: evidenceOf.get(`${m.id}|${d}`) ?? null }));
      return { mentorId: m.id, name: m.name, assigned: assignedCount.has(m.id), ...a, items };
    })
    .sort((x, y) => Number(y.enough) - Number(x.enough) || (y.enough ? y.matches / y.n - x.matches / x.n : 0) || x.name.localeCompare(y.name));

  // "built mostly from": every mentor tied at the highest number of Voices backed (no alphabetical tie-break)
  const topCount = Math.max(0, ...assignedCount.values());
  const tied = [...assignedCount].filter(([, c]) => c === topCount).map(([m]) => nameOf.get(m) ?? m).sort();
  const builtFrom = !topCount
    ? "no mentors"
    : tied.length <= 3
      ? `${tied.join(tied.length === 2 ? " and " : ", ")} (each backs ${topCount} Voice${topCount === 1 ? "" : "s"})`
      : `${tied.length} mentors who each back ${topCount} Voice${topCount === 1 ? "" : "s"}`;
  const closest = hiveVsMentors.find((m) => m.enough) ?? null;
  const headline = rulings.length
    ? `The Hive was built mostly from ${builtFrom}. ` +
      (closest ? `Its rulings matched ${closest.name}'s evidenced choices most often (${closest.matches}/${closest.n}).` : `No mentor shares enough evidenced dilemmas with these rulings yet (n ≥ ${MIN_N}).`)
    : "Reveal has not run for this formation and constitution yet.";

  const activeIds = mentors.map((m) => m.id);
  const perVoice = voices.map((v) => {
    const ms = (formation.assignments[v.id] ?? []).filter((m) => mentorChoices.has(m));
    const tops = voiceTops.get(v.name)!;
    const s = voiceVsMentors(tops, ms, mentorChoices);
    const sug = ms.length < 3 ? suggest({ voiceTop: tops, current: ms, candidates: activeIds, mentorChoices, optionCount }) : { revealed: null, wildcard: null };
    const names = ms.map((m) => nameOf.get(m) ?? m);
    return {
      voiceId: v.id,
      name: v.name,
      mentors: names,
      rulingsVoted: tops.size,
      ...s,
      sentence: !names.length
        ? `${v.name} has no mentors in this formation.`
        : rulings.length && !tops.size
          ? `${v.name} was given ${names.join(" and ")}; it cast no ballots in these rulings${v.name === "LUMEN" || v.name === "WITNESS" ? " (it does not whisper, so it never votes)" : ""}.`
          : s.enough
          ? `${v.name} was given ${names.join(" and ")}; its ballots matched their evidenced choices on ${s.matches}/${s.n}.`
          : `${v.name} was given ${names.join(" and ")}; not enough evidence (n=${s.n}).`,
      suggestions: {
        revealed: sug.revealed ? { mentorId: sug.revealed.mentorId, name: nameOf.get(sug.revealed.mentorId)!, matches: sug.revealed.agreement.matches, n: sug.revealed.agreement.n } : null,
        wildcard: sug.wildcard ? { mentorId: sug.wildcard.mentorId, name: nameOf.get(sug.wildcard.mentorId)!, nEff: sug.wildcard.nEff } : null,
      },
    };
  });

  const voiceNEff = effectiveN(new Map([...voiceTops].filter(([, m]) => m.size > 0)), optionCount);
  const withConst = rulings.filter((r) => r.constitutionChoice !== null && r.choice !== null);
  const differ = withConst.filter((r) => norm(r.constitutionChoice!) !== norm(r.choice!));
  const mirror = key.constitutionVersion === null
    ? { available: false as const, sentence: "No constitution is approved, so there is nothing to mirror." }
    : {
        available: true as const,
        compared: withConst.length,
        differ: differ.length,
        sentence: `Your Hive's constitution would have chosen differently on ${differ.length} of ${withConst.length}.`,
        disagreements: differ.map((r) => ({ situationId: r.situationId, text: textOf.get(r.situationId)!, hive: optText(r.situationId, r.choice), constitution: optText(r.situationId, r.constitutionChoice), cycleId: r.cycleId })),
      };

  return {
    key: { formationVersion: key.formationVersion, formationStatus: formation.status, constitutionVersion: key.constitutionVersion, label: keyLabel(key) },
    progress: { done: rulings.length, total: dilemmas.length, costUsd },
    mock,
    minN: MIN_N,
    headline,
    hiveVsMentors,
    perVoice,
    voiceNEff: { nEff: voiceNEff.nEff, voices: voiceNEff.subjects.length },
    mirror,
    // decision: PASS, or why the Conclave escalated; the top option is the ruling either way (PRODUCT_SPEC §5)
    rulings: rulings.map((r) => ({ situationId: r.situationId, text: textOf.get(r.situationId)!, choice: optText(r.situationId, r.choice), decision: decisionOf.get(r.cycleId) ?? null, cycleId: r.cycleId })),
    escalated: rulings.filter((r) => (decisionOf.get(r.cycleId) ?? "PASS") !== "PASS").length,
  };
}

export type RevealResults = Awaited<ReturnType<typeof revealResults>>;
