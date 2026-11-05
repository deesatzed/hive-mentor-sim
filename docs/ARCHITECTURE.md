# Architecture

## Principles

- **One process, one stack.** Next.js App Router (TypeScript strict), Prisma + SQLite, zod. CLI tools (`tsx`) for the REPL, corpus build, eval, smoke.
- **Decision models judge; LLMs write.** Judgments go through `lib/council/providers/decisions.ts` using questions from `lib/hive/questions.ts`. Text goes through `lib/council/providers/llm.ts` using prompts from `lib/hive/prompts.ts` and `prompts/**/*.md`. No ad-hoc model `fetch` anywhere else.
- **Decide once, record it.** Every judgment is made once and written to `LedgerEvent`. Downstream code reads the recorded numbers.
- **The orchestrator is code; the manager picks the order (owner decision 2026-11-04).** Attention ranking, Conclave math, authorization, quote verification, and promotion rules are deterministic TypeScript. Phase order: in `orchestration.mode: manager` the central manager model (`MANAGER_NEXT_PHASE`) chooses the next phase from the allowed set in `lib/hive/phases.ts` (each phase once, after the phases it needs; P4 and P7 optional; FINISH only after P6). Code validates the choice; invalid choices or failed calls use the code default and are recorded in `trace.orchestration`. `orchestration.mode: code` restores the fixed order. sent2's Invariant 11 is relaxed accordingly for phase order only.
- **Everything has a mock.** `USE_MOCK_PROVIDERS=true` swaps in deterministic mocks for decisions, LLM, and embeddings.

## Directory layout

```
config/hive.yaml                 thresholds, attention, memory, conclave, guilds, tiers→env names,
                                 relevance table, advisor_activation, edict_module, honesty_clause, eval
constitution/
  permissions.yaml               runtime capability matrix (sent2 v1.2 §3.6, SHELTER row removed)
  edict-module.md                optional Symbiosist framework text (authority: designed framework only)
  honesty-clause.md
prompts/
  _shared.md                     prepended to every entity (LLM_PROMPTS.md §2)
  core/*.md (15)  governance/symbiont_prime.md  conclave.md  advisors/*.md (16)
lib/council/                     ported from the council handoff, unchanged in method
  providers/{index,costMeter,decisions,llm,embeddings,mocks}.ts
  ledger.ts  quotes.ts  retrieval.ts  councilMetrics.ts  signals.ts  trackRecord.ts  schemas.ts
lib/hive/
  envelope.ts      typed A2A envelope + body schemas (sent2 v1.2 §3.3; urgency low|normal|high)
  permissions.ts   loads permissions.yaml, authorize()
  bus.ts           broker: authorize → stamp → rate-limit (1 whisper/Voice/cycle) → persist transcript
  voices.ts        loads prompts + agent metadata from seed/voice_roster.json; Voice runner
  lens.ts          attribute lens per Voice: assigned mentors' approved principles + retrieved chunks
  attention.ts     kernel ranking A(m) (CONCLAVE_MATH.md §2), top-k, moral-salience bypass
  conclave.ts      options, κ, α, S(o), decision rule, anti-echo, dissent, bloc audit (CONCLAVE_MATH.md)
  state.ts         scoped append-only memory (private / project / hive), CONFLICT markers, priority decay
  phases.ts        P0–P7 definitions and per-phase allowed entities
  orchestrator.ts  the heartbeat (below)
  arbiter.ts       SYMBIONT PRIME: decision ARBITRATE + optional AMEND text
  faithfulness.ts  TIRELESS pass: every sentence traces to approved refs
  commitments.ts   Commitment Ledger (sent2 v1.3 §3.3)
  egoAudit.ts      five audit questions every N cycles (sent2 v1.3 §3.4)
  coherence.ts     C_intra / C_inter + interoception register (sent2 v1.3 §3.2)
  endorsement.ts   advisor routing + endorsement (M9)
  constitution.ts  draft from mentor principles, verifyReceipts, approve, versions
  formation.ts     voice↔mentor assignments, versions, N_eff
  reveal.ts        ruling-mode runs over dilemmas; Hive/Voice/constitution agreement
  calibration.ts   matched-pair runs and grading
  predictions.ts   Hive predictions + outcomes
  questions.ts     every decision question builder + thresholds (DECISION_LAYER.md)
  prompts.ts       every generation prompt id + zod schema (LLM_PROMPTS.md)
scripts/
  repl.ts                        pnpm dev:repl  (mock by default, --live)
  corpus/{cli,fetch,chunk,authorial,embed,tag,holdout,fingerprint,fidelity,activate}.ts
  eval/{runner,grader,report,cli}.ts      pnpm eval | eval:live
  eval/calibration.ts                     pnpm eval:calibration
  smoke/liveCycle.ts                      pnpm smoke:live
  check-prompts.ts                        pnpm check:prompts
app/ (pages from PRODUCT_SPEC.md)   app/api/... (routes below)
seed/   reports/   tests/unit  tests/e2e  tests/fixtures
```

## Provider interfaces

Identical to the council handoff:

```ts
export type NoulQ   = { type: 'noul';   instructions: string; criteria: { true: string; false: string } };
export type ChoiceQ = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type ScoreQ  = { type: 'score';  instructions: string; criteria: string[] };
export type Question = NoulQ | ChoiceQ | ScoreQ;
export interface DecisionResult {
  answers: Record<string, unknown>; model: string; costUsd: number; latencyMs: number; provider: string;
  calibrated: boolean;                       // false for LocalLLMDecisions and MockDecider
  p(name: string): number; choice(name: string): string;
  probs(name: string): Record<string, number>; score(name: string): number;
}
export interface Decider { decide(state: unknown, qs: Record<string, Question>, opts: { purpose: string; cycleId?: string }): Promise<DecisionResult>; }
export interface LLM {
  generate<T>(promptId: string, vars: Record<string, unknown>, schema: z.ZodType<T>,
              opts: { tier: 'fast' | 'standard' | 'premium'; temperature?: number; maxTokens?: number; purpose: string; cycleId?: string })
    : Promise<{ data: T; model: string; costUsd: number }>;
}
export interface Embedder { model: string; dim: number; embed(texts: string[]): Promise<Float32Array[]>; }
```

`getProviders()`:

| Condition | Decider | LLM | Embedder |
|---|---|---|---|
| `USE_MOCK_PROVIDERS=true` | MockDecider | MockLLM | MockEmbedder |
| `PROVIDER_MODE=cloud` | OpenRouterDecisions | OpenRouterLLM (tier → `TIER_*_MODEL`) | OpenRouterEmbeddings (`OPENROUTER_EMB_MODEL_*`) + OpenRouterReranker (`OPENROUTER_RETRIEVAL_MODEL_*`) |
| `PROVIDER_MODE=local` | LocalLLMDecisions | LocalLLM | OllamaEmbeddings |

An empty `TIER_*_MODEL` falls back to `OPENROUTER_REVIEWER_MODEL` (the owner's central model; for the proof of concept all three tiers are set to it). If both are empty and mocks are off, `getProviders()` throws `LiveModeNotConfiguredError` naming the missing tier. The live eval grader also uses `OPENROUTER_REVIEWER_MODEL`.

Every provider call: `costMeter.add()` with the measured cost after, one `LedgerEvent` with the caller's `purpose` and `cycleId`.

## The heartbeat (`orchestrator.ts`)

Adapted from sent2 v1.2 §3.4. SHELTER steps removed. Each phase writes only the scopes listed; the bus enforces it.

| Phase | Name | Runs | Writes |
|---|---|---|---|
| P0 | INTAKE | Build immutable `TaskContext` {input, sessionId, cycleNo, mode chat\|ruling\|calibration, options?}. Load approved constitution, active formation, Self-Model, active commitments. | task.context |
| P1 | PERCEIVE | In parallel: decision `AFFECT` (SENTIA's register); MNEME retrieval from memory (priority-weighted, CONFLICT markers surfaced); LLM `LEXICON_PARSE` (intent, subtext, register). Decision `HONESTY_PROBE` (is the operator asking about the Hive's consciousness?) when the clause is enabled. | task.context |
| P2 | WHISPER | Fan-out to the 15 Core Voices **minus LUMEN and WITNESS**. Each Voice gets the packet + its **attribute lens** (`lens.ts`) and returns `{claim, request?, evidence: [{chunkId, quote}], uncertainty}` (LLM `VOICE_WHISPER`). Quotes verified; failing evidence dropped and ledgered (`quote.rejected`). Then one batched decision `WHISPER_RATING` assigns confidence, salience, valence to all claims; decision `MORAL_SALIENCE` flags ETHOS/KINDRED claims that must be heard. From M9, advisors run per `advisor_activation` and need endorsement. | task.analysis |
| P3 | ATTEND | `attention.rank()` (code) → shortlist (bypass: moral-salience flagged) + decayed list. LUMEN (LLM `LUMEN_NARRATE`) weaves the shortlist into the awareness line and returns `selected` ids; ids not in the shortlist are rejected by code. Coalition = selected ids. | task.deliberation |
| P4 | DELIBERATE | Decision `CONTRADICTION` over claim pairs → κ. If Conclave triggers (`CONCLAVE_MATH.md` §3): build stable Options; two rounds (LLM `CONCLAVE_ROUND`, moderator only: it restates and steelmans the conflicting Voices' claims; M3 deviation, see PROGRESS.md); ballots via decision `BALLOT` per Core Voice that has a rated claim this cycle (others abstain); aggregate; anti-echo; dissent. Then **WITNESS principal audit**: decision `WITNESS_FLAGS` + LLM `WITNESS_AUDIT` narrative over the full stream, exclusions, and unresolved CONFLICT markers. WITNESS may mandate one REFLECT loop (re-run P2–P4 once with its note). | task.deliberation |
| P5 | GOVERN | SYMBIONT PRIME: decision `ARBITRATE` (PASS / AMEND / ASK_USER) with state = awareness, coalition claims, Conclave result + dissent, audit, constitution principles relevant to the draft (decision `PRINCIPLE_RELEVANT` + `PRINCIPLE_STATUS`), active commitments (decision `COMMITMENT_CONFLICT`). If AMEND: LLM `PRIME_AMEND` writes the guidance. If ASK_USER: compose a clarifying question instead of an answer. Commitment contradiction must be honored or explicitly broken (`commitments.break()` with PRIME approval). | task.governance |
| P6 | COMPOSE | LLM `LEXICON_COMPOSE` (premium tier) renders the coalition + guidance in the Hive's voice. TIRELESS: decision `FAITHFUL` per sentence against approved refs; unfaithful sentences trigger one regeneration with the failing sentences named, then are dropped. Any mentor quote in the output must verify against its chunk, else it is removed. | user.output |
| P7 | REFLECT | Four proposals with provenance: MIRROR `selfmodel.delta` (LLM `MIRROR_DELTA`), MNEME `memory.candidate`, ADAPT outcome-vs-prediction + any new `HivePrediction`, HERITAGE `canon.candidate`. Promotion to hive scope by policy (below). Signals emitted. Ego audit every `ego_audit_every` cycles. Coherence metrics computed. | memory.* |

**Ruling mode** (Reveal, calibration): P0 carries the situation's options; P4 always runs the Conclave with those options as the stable Option set (no option-building step); the winner is the ruling. P6 composes a short explanation. Each Voice's top-scored option is stored per Voice.

**As built (M7):** ruling and calibration modes set `requireP4`, so the manager cannot skip P4. A Voice's top option is stored only when it voted and its best score is not tied. Reveal (`reveal.ts`) keys rulings by (formation version, constitution version): approving a new formation or constitution starts a fresh set; a run resumes where its key left off; a cycle that errors stores no ruling and is retried on resume. `CONSTITUTION_RULING` runs per ruling only when a constitution is approved; its measured cost is added to that ruling's cycle. Ballots in ruling mode carry `mode` in their decision state. Every cycle now records the formation version whose lenses it used (approved, else newest draft). Trace pages: `/cycles/[id]`. CLI: `pnpm reveal [--live] [--limit N] [--db file:./x.db]`. The Conclave decision (PASS or the escalation reason) is shown next to each ruling; the top option counts either way.

**Promotion policy (P7):** a proposal is promoted to hive scope only if (a) every evidence ref verifies, (b) it adds no goal or permission not traceable to an approved constitution principle (else a CONFLICT marker and the ego audit is triggered), (c) for Self-Model deltas, coherence-decreasing but accuracy-increasing deltas (recording a contradiction) are never rejected on coherence grounds alone. Constitution text itself is never changed by P7, only by the operator.

**Cost:** `costMeter` records measured spend per model and per phase for the trace. There is no cap (owner decision 2026-11-04: no spending cap in the build; the owner limits spend with per-key OpenRouter limits; the build records measured cost only).

## Attribute lens (`lens.ts`)

For each Core Voice, per cycle:
1. Assigned mentors from the active formation (only `active=true` mentors).
2. Up to 5 approved `MentorPrinciple`s per mentor most relevant to the input (embedding similarity, code).
3. Top 3 non-held-out chunks per mentor from `retrieval.search(mentorIds, input + parse.intent, k)`.
4. Passed to `VOICE_WHISPER` as `[chunkId] (mentor, work, locator) text`. The Voice may cite only these chunk ids.

A Voice whose mentors are all inactive gets an empty lens; its whisper card shows "no attribute lens."

## Commitments, ego audit, coherence

Ported from sent2 v1.3 (§3.2–3.5) with these changes:
- Commitments are proposed by ARROW in P7 when the output states a position, refuses, adopts canon, or promises; stored with `cost_type`. P5 checks drafts against active commitments.
- Ego-audit question "processes over principles" counts cycles where procedure was satisfied while a moral-salience whisper was excluded from awareness. The other four questions are as in sent2.
- Coherence: value vectors from whisper-claim embeddings (Embedder), C_intra per Voice across cycles and C_inter across Voices; healthy C_inter band from config. Values written to `InteroceptionSample`.

**As built (M4):** commitments are broken only through P5: when the arbiter AMENDs and `PRIME_AMEND` names a conflicting commitment in `breakCommitment`, `CommitmentLedger.break(..., approvedBy: "SYMBIONT_PRIME")` writes the breakage record, a `commitment.broken` ledger event, and a promoted Self-Model version listing it; any other approver throws. REFLECT mandates: a failed ego audit (on demand when a Self-Model delta is refused, or every `ego_audit_every` cycles) or a CONFLICT marker open for `memory.conflict_escalation_cycles` cycles makes P4 required in the next cycle (the manager cannot skip it) and runs one REFLECT loop there; markers that triggered it are then marked resolved. Coherence is measured after P2 with the configured Embedder and is "unavailable" when none is configured.

## Council metrics, signals, track record

Unchanged formulas from the council handoff (`councilMetrics.ts`, `signals.ts`, `trackRecord.ts`), applied to:
- **Mentor N_eff** over active mentors (κ from `MentorAnswer` choices on dilemmas).
- **Voice ballot N_eff** over Voices (κ from each Voice's top option across Reveal rulings).
- **Signals**: `tension` per constitution principle when `PRINCIPLE_STATUS` says the composed output works against it; `dissent` per Voice when its ballot top choice ≠ the Conclave winner. Half-life 14 days by default (config may switch to half-life in cycles); surfacing thresholds as in the council handoff (tension density ≥ 3.0, re-surface after 14 days or +1.5), and a dismissal hides a pattern for 30 days.
- **Track record** per Voice and per mentor lens over `HivePrediction` outcomes; counts only below n = 10.

## API routes (`app/api/...`, localhost only, no auth)

| Route | Method | Purpose |
|---|---|---|
| `mentors` | GET | roster + stats |
| `formation` | GET/PUT | current + history / save new version |
| `constitution` | GET/POST | current + history / generate draft |
| `constitution/principles/[id]` | PATCH | edit / approve / retire |
| `sessions` | GET/POST | list / new chat session |
| `sessions/[id]/cycle` | POST | run one heartbeat (streams phases via SSE) |
| `cycles/[id]` | GET | full trace + transcript |
| `reveal` | GET/POST | results / start or resume run |
| `calibration` | GET/POST | results / run pair(s) |
| `predictions` | GET | list + due |
| `predictions/[id]/checkin` | POST | outcome |
| `commitments` | GET | list |
| `interoception` | GET | samples, patterns, bloc audit, ego audits |
| `patterns/[id]/dismiss` | POST | dismiss |
| `ledger` | GET | events + spend |
| `settings` | GET | read-only config view |
| `admin/reset` | POST | reset DB (typed confirmation) |
