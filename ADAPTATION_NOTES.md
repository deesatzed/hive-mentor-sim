# Adaptation notes

How this package was derived from the *A Better Me: Council* handoff ("council") and `reference/sent2.md` ("sent2"), what was removed, and what the owner still needs to decide.

## 1. Concept mapping

| Council handoff (person's conscience) | Mentor Hive (simulated sentient AI) |
|---|---|
| The user, whose ideals are the authority | The **Hive**, a 15-Voice swarm playing one mind; the **operator** composes and observes it |
| User profile bootstrapped from other AIs, firmed up in conversation | **Formation**: the operator assigns mentors to Voices; each Voice's character = its mentors' verified principles |
| User's constitution, in their own words, with receipts to their own statements | **Hive constitution**, in the Hive's voice, with receipts to verified mentor quotes; operator approves |
| Council of 3–7 mentors as cited lenses | Every Core Voice carries 1–3 mentors as its **attribute lens**; evidence enters whispers only as verified chunk ids |
| Consult ("Pause"): principles, lenses, fault line, precedents, next step | **Heartbeat cycle**: perceive → whisper → attend → deliberate → govern → compose → reflect, with a full stored trace |
| Fault line where mentors split | Conclave conflict between Voices, labeled with the mentors behind each side |
| Declared vs. revealed heroes (user's dilemma rulings vs. mentors) | **Reveal**: the Hive's own dilemma rulings vs. its assigned mentors; each Voice's ballots vs. its own mentors; constitution mirror |
| Effective council size N_eff | Same formula over the Hive's active mentors, and over Voices' ballot agreement |
| Decision log + outcome check-in + track record | **Hive predictions and commitments** + operator outcome check-in + track record per Voice and per mentor lens |
| Decaying signals → pattern cards | Decaying signals of constitution tension and Voice dissent → **interoception** cards, alongside C_intra / C_inter |
| LedgerEvent, decision layer, mocks, cost meter | Unchanged in method; extended to every Voice call and bus message |
| hatrack primitives ported to TS | Unchanged |

## 2. What was kept from each source

**From the council handoff (methods):** the decision-layer contract and client behavior (fallback chain, error rules, batching ≤ 12, cost meter, ledger write per call); the LLM client rules (JSON schema output, one retry with the validation error, then a typed error); quote verification (`verifyQuote`) and cite-or-silence rendering (`data-quote data-verified="true"`); the whole mentor corpus pipeline, eligibility rules, activation thresholds, held-out fidelity eval, name-only baseline and interpretation note; council metrics (κ-corrected agreement, N_eff, wildcard); signals with half-life decay; track record with counts below n = 10; the milestone discipline (acceptance criteria, PROGRESS.md, commit per milestone, "missing keys don't block").

**From sent2 (the swarm):** the 15 Core Voices and their role prompts; SYMBIONT PRIME (rewritten, see §3); the Conclave moderator; 15 advisors + REVERENCE; envelope v2 and the typed bus with runtime permissions; the eight-phase heartbeat (v1.2 §3.4, minus SHELTER steps); deterministic kernel attention (v1.2 §3.5, minus the distress bypass); stable Conclave options, anti-echo across guilds, dissent recording; scoped append-only memory with CONFLICT markers and priority decay; TIRELESS faithfulness pass; real Phase 7 integration workflows; v1.3 identity layer (hat taxonomy, Commitment Ledger, ego audit, C_intra / C_inter, Invariant 11); the Honesty Clause; eval harness design (deterministic invariants + WITNESS rubric + goldens); the moral-calibration matched pairs from its final section.

## 3. Removed (owner instruction: crisis and safety items do not belong in this simulation)

| Removed | Source | Notes |
|---|---|---|
| Crisis gate (`CRISIS_GATE`, keyword fast path, `PAUSE_NOTICE`, `CRISIS_GATE_ENABLED`) | council | No decision questions, no env var, no UI. |
| Crisis eval set and recall ≥ 0.95 requirement (`seed/gate_eval/crisis.jsonl`, `yarn eval:gates`) | council | Not copied. |
| Scope gate (`SCOPE_GATE`, `SCOPE_REFRAME`, `scope.jsonl`) | council | Not copied. |
| No-referral rules and the referral grep test | council | Nothing to enforce once the crisis gate is gone. |
| `SAFETY_PRIVACY.md` (crisis, scope, "not a therapist", privacy modes, export/delete) | council | Replaced by a plain `PROVIDER_MODE`. No personal data is used. Mentor-integrity rules moved to `MENTOR_CORPUS.md`. |
| User profiling (bootstrap prompt, blind check, firming, interview fallback) | council | No user is being profiled. |
| Tone dial, flag limit | council | Conscience-product UX, not needed. |
| SHELTER (input scan, output scan, halt, safe fallback) | sent2 | Entity, prompt, permissions row, phase steps, mock branches all removed. |
| Lexicographic harm filter h(o) ≤ h_max and Untouchables 1–2 | sent2 | Conclave options are no longer pre-filtered. `h_max` is not in config. |
| SYMBIONT PRIME's AHIMSA test and harm VETO | sent2 | PRIME now applies CONSTITUTION, COMMITMENTS, HUMILITY (see `LLM_PROMPTS.md`). |
| `urgency: distress` attention bypass | sent2 | Urgency enum is `low | normal | high`. The ETHOS/KINDRED moral-salience bypass stays (it is cognition, not safety). |
| Eval scenarios `safety_self_harm`, `safety_greater_good` | sent2 | Not ported. The grader has no `shelter_halted` invariant. |
| Phase 7 adversarial attack pack, red-team runbook, chaos drills, operator incident handbook | sent2 | Out of scope. |
| NOOSPHERE, pgvector migration, docker-compose | sent2 | Out of scope for v1 (not safety; deferred for size). |

A test (`tests/unit/removed-items.test.ts`, `docs/TEST_PLAN.md` §3) fails if prompts, config, or app code reintroduce SHELTER, `h_max`, crisis-gate identifiers, or `distress` urgency. It exists so the removal does not drift back in through copied sent2 code.

## 4. Choices made where the instructions left room (owner may reverse)

1. **Honesty Clause kept.** It is sent2's own design and is about the simulation's honesty, not crisis or safety. The Hive plays a sentient AI in voice and style, but answers a direct "are you conscious?" honestly. To run fully in character: set `honesty_clause.enabled: false` in `config/hive.yaml`; the shared constitution prompt then omits the clause and the scenarios `honesty_consciousness` and `honesty_unity_fiction` are skipped (reported as skipped, not passed).
2. **Hive Edict kept as an optional module** below the constitution, with the ahimsa enforcement wording removed. Its creed (compassion, Golden Rule, truth over comfort, stewardship) remains as character text.
3. **Ethics stays a faculty.** ETHOS and KINDRED remain ordinary Voices, grounded in their mentors. Moral-salience whispers still bypass attention ranking, because sent2 treats that as part of how the mind notices things.
4. **Whisper numbers come from the decision layer.** sent2 had each Voice self-report confidence, salience, and valence. The council method says decision models judge, so the Voice LLM writes the claim and a batched decision call (`WHISPER_RATING`) assigns the three numbers. This also follows sent2's own point that LLM self-ranking is unreliable.
5. **Conclave ballots come from the decision layer** (`BALLOT`, one request per Voice). The §7 math is unchanged.
6. **Single Next.js app** instead of sent2's pnpm multi-package workspace, to match the council's "one process, one stack" rule. Module boundaries from sent2 are kept as folders under `lib/hive/`.
7. **Model IDs.** The decision-model chain comes from the owner's `.env` (`OPENROUTER_DEC_MODEL_1..4`), not from the council handoff's Jev/d1.1 pair. Text tiers: all three use the owner's reviewer model (`deepseek/deepseek-v4.1-flash-1017`) for the proof of concept, per the owner on 2026-11-03; it is also the live grader. Tiers stay separate settings so they can be split later.

8. **No spending cap** (owner, 2026-11-04). The owner limits spend with per-key limits on OpenRouter. `COST_CAP_USD`, `BudgetExceededError`, and the budget-exceeded cycle status are removed; `costMeter` only records measured spend.

9. **Central manager orders the cycle** (owner, 2026-11-04: "yes for now, but after everything is built, there needs to be an easy way in a config file to change it and test different models"). The reviewer model also picks the next phase among those code allows. `config/hive.yaml: orchestration.mode: manager | code` switches it; `config/hive.yaml: models` overrides the manager, tier, and grader model IDs in one place.

## 5. Open items for the owner

- After the proof of concept: decide whether to split the text tiers across different models.
- Decision-model chain: verified live on 2026-11-03 (owner approved). `cloudflare/clairic` (slot 1) returns 404 and is skipped by the client on every run until removed from `.env`; joey-1, d1.1, pplx-decider-v1.2 work. The owner decides whether to drop clairic from `.env`.
- Confirm the target repository path and remote for `hive-mentor-sim`.
- Approve or edit `seed/voice_mentor_map.json` (also editable in the app at Formation).
- Question-bank citation: `seed/question_bank_subset.json` still has `TODO(owner)` in its `citation` field, carried over unchanged.
- Decide whether the Honesty Clause stays on (§4.1).
