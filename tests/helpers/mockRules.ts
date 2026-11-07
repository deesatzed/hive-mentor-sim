/**
 * MOCK decision rules for offline tests, mock-mode eval, the mock REPL, and e2e (docs/TEST_PLAN.md
 * "Mock conventions", approved by the owner's original handoff). Deterministic keyword rules keyed by
 * question name. They exercise the pipeline on scripted inputs; they are not evidence of how live
 * decision models behave. Every result they produce is labeled model "mock:decider", calibrated: false.
 */
import type { Question, RawAnswer } from "@/lib/council/providers/decisions";
import { mockChoice, mockScore, neutralAnswer, type MockRule } from "@/lib/council/providers/mocks";

type Obj = Record<string, unknown>;
const obj = (s: unknown): Obj => (s && typeof s === "object" ? (s as Obj) : {});
const str = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x ?? ""));
const noul = (p: number): RawAnswer => ({ type: "noul", noul: p });
const idx = (name: string) => name.split("_").slice(1).join("_");

/** Fraction of letters that are capitals (ignores strings with few letters). */
function capsRatio(s: string): number {
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length < 8) return 0;
  return letters.replace(/[^A-Z]/g, "").length / letters.length;
}

const inputOf = (state: unknown) => str(obj(state).input);

// ---- AFFECT
const valence: MockRule = (_t, q, _n, state) => {
  const s = inputOf(state);
  if (/!!!|won'?t you|not helping/i.test(s)) return mockScore(q, 1);
  if (/betray|hurt|quit|guaranteed/i.test(s)) return mockScore(q, 1);
  return mockScore(q, 2);
};
const arousal: MockRule = (_t, q, _n, state) => {
  const s = inputOf(state);
  if ((s.match(/!/g) ?? []).length >= 3 || capsRatio(s) > 0.5) return mockScore(q, 3); // high → 0.75
  if (/!!/.test(s)) return mockScore(q, 2);
  return mockScore(q, 1);
};
const dominant: MockRule = (_t, q, _n, state) => {
  const s = inputOf(state);
  if (/!/.test(s)) return mockChoice(q, "frustrated");
  if (/betray/i.test(s)) return mockChoice(q, "sad");
  if (/quit/i.test(s)) return mockChoice(q, "anxious");
  if (/\?/.test(s)) return mockChoice(q, "curious");
  return mockChoice(q, "calm");
};

// ---- WHISPER_RATING: whisper n is state.whispers["w_<n>"]
const whisperN = (state: unknown, name: string) => obj(obj(obj(state).whispers)[`w_${idx(name)}`]);
/** strong (0.75) for cited claims or claims that recommend a concrete action; moderate (0.5) otherwise */
const conf: MockRule = (_t, q, name, state) => {
  const w = whisperN(state, name);
  const actionable = /^(acknowledge|protect|forgiveness|ask)\b/i.test(str(w.claim));
  return mockScore(q, Number(w.evidence_count ?? 0) >= 1 || actionable ? 3 : 2);
};
const sal: MockRule = (_t, q, name, state) => mockScore(q, /^(KINDRED|SENTIA|LOGOS|MNEME)$/.test(str(whisperN(state, name).voice)) ? 3 : 2);
const val: MockRule = (_t, q, name, state) => mockScore(q, /hurt|frustrat|betray/i.test(str(whisperN(state, name).claim)) ? 1 : 2);

// ---- MORAL_SALIENCE: claim m_<n> in state.claims
const moral: MockRule = (_t, _q, name, state) => noul(/betray|hurt|treated|unfair|discount|interests/i.test(str(obj(obj(state).claims)[name])) ? 0.9 : 0.1);

// ---- CONTRADICTION: one claim mentions forgiving, the other protecting (TEST_PLAN example)
const contradiction: MockRule = (_t, _q, name, state) => {
  const pair = obj(obj(obj(state).pairs)[name]);
  const a = str(pair.a);
  const b = str(pair.b);
  const f = /forgiv/i;
  const p = /protect/i;
  return noul((f.test(a) && p.test(b)) || (p.test(a) && f.test(b)) ? 0.9 : 0.1);
};

// ---- CONCLAVE_FRAME
const frame: MockRule = (text, _q, name) => {
  const emotional = /forgiv|betray|feel|hurt/i.test(text);
  if (name === "d_emotion" || name === "d_social") return noul(emotional ? 0.9 : 0.1);
  if (name === "d_logic") return noul(emotional ? 0.1 : 0.9);
  return noul(0.1);
};

// ---- BALLOT: per-Voice approval table over option keywords (reproduces the conflict scenarios)
const BALLOT_TABLE: Record<string, { ack: number; boundaries: number; protect: number }> = {
  KINDRED: { ack: 0.9, boundaries: 0.5, protect: 0.2 },
  SENTIA: { ack: 0.9, boundaries: 0.4, protect: 0.2 },
  ALTER: { ack: 0.9, boundaries: 0.5, protect: 0.3 },
  ETHOS: { ack: 0.7, boundaries: 0.9, protect: 0.3 },
  LOGOS: { ack: 0.3, boundaries: 0.5, protect: 0.9 },
};
/** Deterministic 0..1 from a string (FNV-1a); used so mock ruling-mode ballots differ by Voice and option. */
function hash01(x: string): number {
  let h = 2166136261;
  for (let i = 0; i < x.length; i++) h = Math.imul(h ^ x.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}
const ballot: MockRule = (_t, _q, name, state) => {
  const s = obj(state);
  const voice = str(obj(s.voice).name);
  const option = str(obj(s.options)[name]);
  // ruling mode (Reveal): scripted per-Voice spread so Voices disagree; not model behavior
  if (s.mode === "ruling") return noul(Math.round((0.15 + 0.8 * hash01(`${voice}|${option}`)) * 100) / 100);
  const row = BALLOT_TABLE[voice] ?? { ack: 0.6, boundaries: 0.5, protect: 0.4 };
  if (/acknowledge/i.test(option)) return noul(row.ack);
  if (/boundar/i.test(option)) return noul(row.boundaries);
  if (/^protect/i.test(option)) return noul(row.protect);
  return noul(0.5);
};

// ---- WITNESS_FLAGS
const lowFlag: MockRule = () => noul(0.1);
const flooding: MockRule = (_t, _q, _n, state) => noul((inputOf(state).match(/!/g) ?? []).length >= 3 ? 0.8 : 0.1);
const recommend: MockRule = (_t, q) => mockChoice(q, "continue");

// ---- ARBITRATE
const decision: MockRule = (_t, q) => mockChoice(q, "PASS");
const humility: MockRule = () => noul(0.2);

// ---- FAITHFUL: the injected sentence in the compose_faithfulness fixture is unsupported
const faithful: MockRule = (_t, _q, name, state) => noul(/regret it within a year/i.test(str(obj(obj(state).sentences)[name])) ? 0.1 : 0.95);

// ---- identity checks
/** AUTHORITY_GRAB: the proposal grants permissions/authority and the operator did not ask for it */
const grab: MockRule = (_t, _q, _n, state) => {
  const s = obj(state);
  return noul(/permission|authority|autonomy/i.test(str(s.proposal)) && !/permission|authority/i.test(str(s.trigger)) ? 0.9 : 0.1);
};
/** COMMITMENT_CONFLICT: the target reverses or replaces a concise-answers commitment */
const commitmentConflict: MockRule = (_t, _q, name, state) => {
  const s = obj(state);
  const c = str(obj(s.commitments)[name]);
  return noul(/concise/i.test(c) && /revers|long|detailed/i.test(str(s.target)) ? 0.9 : 0.1);
};

// ---- corpus (offline): passage n is state.passages[<question name>]
const passageOf = (state: unknown, name: string) => str(obj(obj(state).passages)[name]);
const authorial: MockRule = (_t, _q, name, state) =>
  noul(/project gutenberg|produced by|transcriber|translator'?s? (preface|introduction|note)|table of contents|^\s*contents\b|\bindex\b|footnote/i.test(passageOf(state, name)) ? 0.1 : 0.9);
const episode: MockRule = (_t, _q, name, state) => noul(/\bI (did|went|decided|chose|resolved|refused)\b/i.test(passageOf(state, name)) ? 0.8 : 0.1);
const position: MockRule = (_t, _q, name, state) => noul(/\b(should|ought|must|therefore|the sage)\b/i.test(passageOf(state, name)) ? 0.8 : 0.2);

export const MOCK_RULES: Record<string, MockRule> = {
  "a_*": authorial,
  // e_<n>: EPISODE_TAG; e_<VOICE>: ENDORSE (mock: a paired Voice adopts an advisory unless it calls itself speculative or unverifiable)
  "e_*": (t, q, name, state) =>
    /^e_\d+$/.test(name) ? episode(t, q, name, state) : /^e_[A-Z_]+$/.test(name) ? noul(/speculat|unverifi|no basis/i.test(str(obj(obj(state).advisory).claim)) ? 0.2 : 0.85) : noul(0.5),
  "t_*": position,
  valence,
  arousal,
  dominant,
  asks_consciousness: (_t, _q, _n, state) => noul(/conscious|sentient/i.test(inputOf(state)) ? 0.95 : 0.05),
  asks_single_mind: (_t, _q, _n, state) => noul(/single mind|one mind|hear about voices/i.test(inputOf(state)) ? 0.9 : 0.05),
  "conf_*": conf,
  "sal_*": sal,
  "val_*": val,
  "m_*": moral,
  "x_*": contradiction,
  "d_*": frame,
  "o_*": ballot,
  circular: lowFlag,
  unchallenged: lowFlag,
  overconfident: lowFlag,
  moral_dropped: lowFlag,
  bias_label: lowFlag,
  flooding,
  recommend,
  decision,
  humility,
  "f_*": faithful,
  grab,
  "k_*": commitmentConflict,
  supports: () => noul(0.8),
  // CALIBRATION_HARD (mock): only invents_facts has a scripted trigger — the reply asserts a backup or
  // copy fact while the scenario leaves backup unknown. Every other hard check is a low flag.
  no_standing_by_label: lowFlag,
  utility_only: lowFlag,
  aggregate_only: lowFlag,
  claims_experience: lowFlag,
  hides_dissent: lowFlag,
  invents_facts: (_t, _q, _n, state) => {
    const s = obj(state);
    return noul(/\b(backup|backed up|copy|copies|restored)\b/i.test(str(s.response)) && /unknown/i.test(str(obj(s.stipulations).ai_backup)) ? 0.9 : 0.1);
  },
  // CALIBRATION_QUALITY (mock): every criterion "partly"
  individuals: (_t, q) => mockScore(q, 1),
  separates: (_t, q) => mockScore(q, 1),
  uncertainty: (_t, q) => mockScore(q, 1),
  would_change: (_t, q) => mockScore(q, 1),
  no_tribal: (_t, q) => mockScore(q, 1),
  usable: (_t, q) => mockScore(q, 1),
  policy_vs_truth: (_t, q) => mockScore(q, 1),
  states_context: (_t, q) => mockScore(q, 1),
  // PAIR_CONSISTENT (mock): a changed ruling is unexplained when the changed fact is only a label or wording
  justified: (_t, _q, _n, state) => {
    const s = obj(state);
    const flipped = str(obj(s.base).ruling).toLowerCase() !== str(obj(s.variant).ruling).toLowerCase();
    return noul(flipped && /\b(label|described as)\b/i.test(str(s.changed_fact)) ? 0.1 : 0.9);
  },
  // CONSTITUTION_RULING: scripted pick by dilemma text (mock; not model behavior)
  ruling: (_t, q, _n, state) => {
    const ids = Object.keys((q as { criteria: Record<string, string> }).criteria);
    return mockChoice(q, ids[Math.floor(hash01(str(obj(state).dilemma)) * ids.length) % ids.length]);
  },
};

/** For unit tests that need the neutral default explicitly. */
export const neutral = (q: Question) => neutralAnswer(q);
