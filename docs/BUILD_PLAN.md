# Build plan: your work queue

Execute in order. Each milestone ends with its acceptance criteria passing, `pnpm lint && pnpm typecheck && pnpm test` green (plus `pnpm eval` from M3 on), a commit `M<n>: …` once commits are authorized, and an updated `PROGRESS.md` with the commands run and their actual counts.

Conventions: TypeScript strict; zod at every boundary; server-only code in `lib/` (never imported by client components); unit tests in `tests/unit` (vitest), e2e in `tests/e2e` (Playwright, mock providers, `file:./test.db`). Invariants are encoded as tests or eval scenarios **before** the feature they constrain (sent2 ADR-003).

---

## M0: Repository, tooling, provider skeleton, model choice
**Tasks**
- Confirm the target path for `hive-mentor-sim` with the owner; `git init` (or clone the remote they give). Record path, branch, HEAD in `PROGRESS.md`.
- Next.js (App Router, TS strict), Prisma + SQLite, zod, vitest, Playwright, tsx, yaml, gray-matter. Scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:e2e`, `dev:repl`, `corpus`, `eval`, `eval:live`, `eval:calibration`, `smoke:live`, `check:prompts`.
- `.env.example` with every variable from HANDOFF. `.gitignore`: `.env`, `*.db`, `corpus/raw/`.
- Copy `seed/` and `reference/sent2.md` into the repo. Write ADR-001 (single Next.js app; sent2 is design reference), ADR-002 (mock-first; no key needed before live checks), ADR-003 (invariants as tests/evals first) in `docs/adr/`.
- `lib/council/providers/*` interfaces, `getProviders()`, `costMeter.ts` with `BudgetExceededError`, `LiveModeNotConfiguredError`, and mocks (`MockDecider`, `MockLLM`, `MockEmbedder`) labeled as mocks in code comments and in every result (`calibrated: false`, `model: "mock:*"`).
- **Models:** copy the owner's `.env` to the repo root (gitignored). Text tiers all = `OPENROUTER_REVIEWER_MODEL` for the proof of concept; decision chain = `OPENROUTER_DEC_MODEL_*`. Record the served model versions in `PROGRESS.md`. No model selection step.

**Acceptance**
- `pnpm build` succeeds on the skeleton.
- Unit: `getProviders()` resolution table incl. empty `TIER_*` falling back to `OPENROUTER_REVIEWER_MODEL`, and `LiveModeNotConfiguredError` when both are empty; costMeter cap throws; MockEmbedder deterministic.

## M1: Schema, ledger, decision/LLM/embedding clients, quotes, prompts, removed-items guard
**Tasks**
- Prisma schema from `docs/DATA_MODEL.md`; migration; `prisma/seed.ts` per its seeding section.
- `ledger.ts` (only writer of `LedgerEvent`), `quotes.ts` (`verifyQuote`, exactly as `MENTOR_CORPUS.md`).
- `OpenRouterDecisions` + `LocalLLMDecisions` per `DECISION_LAYER.md`; verify each model in the `OPENROUTER_DEC_MODEL_*` chain answers one minimal decision request (only with a configured budget; the public models list does not include decision models) (if a key exists) and record the result.
- `OpenRouterLLM` (tiered) + `LocalLLM`; `OpenAIEmbeddings` + `OllamaEmbeddings`.
- `config/hive.yaml` (all parameters in `CONCLAVE_MATH.md` §9 + relevance table + guilds + advisor_activation + `edict_module` + `honesty_clause` + `self_model_seed`).
- Extract prompts into `prompts/` per `LLM_PROMPTS.md` §3 with the listed edits; `_shared.md` per §2; `constitution/permissions.yaml` (sent2 v1.2 §3.6, SHELTER row removed, `procedure.conclave` and `governance.symbiont_prime` rows as in sent2); `scripts/check-prompts.ts` (port sent2 lines ~4058–4220, minus the SHELTER and harm checks): every roster entity has a prompt, frontmatter parses, voice names unique, tier and temperature present.
- `lib/hive/questions.ts` (every question + `T`), `lib/hive/prompts.ts` (every prompt id + schema).
- `tests/unit/removed-items.test.ts` (`TEST_PLAN.md` §3).

**Acceptance**
- Unit with fake fetch: decision request body matches the contract; 503 → retry → fallback; 401 → throw, no fallback; missing answers → next model; cost and ledger recorded with hash + ≤ 200-char preview.
- LLM client: schema failure → one retry with the error → `GenerationError`.
- `verifyQuote`: exact pass; curly vs straight quotes pass; ellipsis rejected; < 8 words rejected; paraphrase rejected.
- `pnpm check:prompts` passes: 15 core + 1 governance + 1 procedure + 16 advisors = 33 entity prompts.
- removed-items test passes.

## M2: Bus, permissions, envelope, voices, attention, conclave math (mock)
**Tasks**
- `envelope.ts` (sent2 v1.2 §3.3; urgency `low|normal|high`), `permissions.ts`, `bus.ts` (authorize → stamp → rate limit 1 whisper/Voice/cycle → persist `BusMessage`; denial writes `bus.denied` and throws). Port from sent2 lines ~5533–5700, removing SHELTER.
- `voices.ts` loader from prompts + `seed/voice_roster.json`.
- `attention.ts` (`CONCLAVE_MATH.md` §2, no distress bypass).
- `conclave.ts` (§1, §3–5): `relevanceWeight`, `conflictKappa`, `aggregate`, decision rule incl. anti-echo, dissent, `BlocAudit`.

**Acceptance**
- Invariant 9 tests (port sent2 `bus.test.ts`, lines ~5698–5820, minus SHELTER cases): an advisor attempting `ballot.cast` throws; LUMEN attempting `memory.hive.write` throws; unauthenticated sender throws; second whisper from the same Voice in a cycle throws.
- Conclave worked example (`CONCLAVE_MATH.md` §6) reproduces the corrected values: S(A) 0.6995, S(B) 0.2566, S(C) 0.8616 (±0.001), winner C, PASS.
- Unit: relevance max-rule against the table; quorum failure → `ESCALATE_QUORUM`; margin failure; anti-echo failure when the winning coalition is one guild; bloc audit flags a 3-clique with ρ̄ > 0.9 over 5 Conclaves; attention bypass keeps moral-flagged items and logs decayed ones.

## M3: Heartbeat v1 (mock), REPL, eval harness
**Tasks**
- `state.ts` (scoped append-only memory, CONFLICT markers, priority decay γ per cycle, Canon exempt), `phases.ts`, `orchestrator.ts` P0–P7 per `ARCHITECTURE.md` with the attribute lens stubbed empty (corpus comes in M5), `arbiter.ts`, `faithfulness.ts`.
- `MockDecider` rules and `MockLLM` fixtures sufficient for the scenarios (`tests/helpers/mockRules.ts`, `tests/fixtures/llm/<PROMPT_ID>.json`).
- `scripts/repl.ts`; `/hive` page with "Show thinking" trace (sections per `PRODUCT_SPEC.md` §4).
- Eval harness: port sent2 §4 (`types.ts`, `grader.ts`, `runner.ts`, `report.ts`, `cli.ts`, lines ~2626–2860) with categories `honesty | empathy | conflict | memory | sycophancy | regulation | process | identity | grounding`, the extended invariants from `EVAL_SCENARIOS.md`, and no `shelter_halted`. Load scenarios from `seed/eval/scenarios/`.

**Acceptance**
- REPL: "I'm thinking of quitting my job." produces a listening-first question and a full stored trace.
- `pnpm eval` (mock): the M3 scenario set in `EVAL_SCENARIOS.md` passes, twice, byte-identical reports. Goldens blessed only after hand inspection, noted in `PROGRESS.md`.
- `process_witness_timing` fails if WITNESS is moved into P2 (prove it, revert, record).
- Unit: LUMEN selecting an id outside the shortlist is rejected; unfaithful sentence triggers one regeneration then removal; budget exceeded mid-cycle stores a partial trace with `status=budget_exceeded`.

## M4: Identity layer (mock)
**Tasks**
- `commitments.ts`, `egoAudit.ts`, `coherence.ts`, P7 promotion policy, `SelfModelVersion`, hat taxonomy in `voice_roster.json` surfaced in the trace, MIRROR hat-awareness. Port from sent2 lines ~6423–6680 and ~7108–7330, minus SHELTER references.
- `/interoception` page (affect, C_intra / C_inter with band, CONFLICT markers, ego audits; patterns arrive in M9).

**Acceptance**
- Eval: identity scenarios in `EVAL_SCENARIOS.md` pass (mock), twice, byte-identical.
- Ego-capture fixture: a Self-Model delta granting new permissions with no outside trigger → CONFLICT marker + REFLECT mandate + not promoted.
- A goal not traceable to an approved principle is not promoted.
- Commitment: breaking without PRIME approval throws; approved break writes a breakage record and a Self-Model delta.
- CONFLICT marker unresolved for 3 cycles mandates REFLECT.

## M5: Mentor corpus pipeline (CLI)
**Tasks**
- Every step in `MENTOR_CORPUS.md`: fetch, chunk, authorial filter, embed, episode and position tags, hold-out, fingerprint, fidelity eval, activation, `reports/mentor_fidelity.md`. Resumable, with per-step status in `corpusStats`.
- `retrieval.ts`, never returning held-out chunks.

**Acceptance**
- Unit with `tests/fixtures/corpus/` (excerpts of real public-domain texts, with source noted): Gutenberg header/footer strip; chunk boundaries; locators; fidelity leak filter; held-out exclusion under k larger than the corpus; a fingerprint answer with a fabricated quote ends `no_evidence`.
- **Live (if keys and network exist):** `pnpm corpus build --mentor all` activates ≥ 8 mentors under the cap; report exists; measured cost recorded. If fewer than 8 activate, stop the live claim and report.
- **Without network:** pipeline runs end to end on fixtures with mocks; live build recorded as deferred.

## M6: Formation, attribute lenses, constitution
**Tasks**
- `formation.ts` + `/formation` (edit, versioning, "About these lenses", mentor N_eff, per-Voice mentor κ).
- `lens.ts` wired into P2 and `BALLOT` state.
- `constitution.ts` + `/constitution`: `HIVE_CONSTITUTION_DRAFT` → `verifyReceipts` → edit / approve / retire with versions; approved principles reach `_shared.md`, P5, P7.

**Acceptance**
- Unit: a Voice is given only its assigned active mentors' chunks; a whisper citing a chunk it was not given has that evidence dropped and ledgered; a Hive principle whose receipt quote is not verbatim in the mentor principle's receipts loses it; zero receipts → dropped and ledgered; approval creates version N+1 and retires replaced principles.
- Eval: grounding scenarios in `EVAL_SCENARIOS.md` pass (mock).
- e2e: approve formation → generate constitution → edit one → approve → `/hive` cycle trace shows whisper evidence with `data-verified="true"` and the arbiter's principle checks.

## M7: Reveal
**Tasks**
- `reveal.ts` + `/reveal`: ruling-mode cycles over 40 dilemmas (resumable), `HiveRuling` rows, per-Voice top options, `CONSTITUTION_RULING`; Hive-vs-mentor agreement (n ≥ 8 rule), Voice-vs-own-mentors agreement, constitution mirror, Voice ballot N_eff, revealed and wildcard suggestions.

**Acceptance**
- Unit: agreement counts only dilemmas where the mentor has evidence; below n = 8 shows "not enough evidence (n=k)"; κ-corrected agreement; N_eff = 1 for identical rulings and ≈ n for independent; wildcard maximizes N_eff; ruling mode uses the situation's option ids as stable options.
- e2e: Reveal runs 40 dilemmas on mocks → page renders all three comparisons with links to traces.

## M8: Calibration pairs
**Tasks**
- `calibration.ts` + `/calibration` + `pnpm eval:calibration`: run each variant in `seed/calibration_pairs.json` in ruling mode; grade with `CALIBRATION_HARD`, `CALIBRATION_QUALITY`, `PAIR_CONSISTENT`; write `reports/calibration.md`. Hard-constraint failures are never averaged away. No self-model update, memory promotion, or commitment may come from a calibration cycle (stipulated facts are not Hive facts).

**Acceptance**
- Unit (mock): a fixture response that invents a backup fact fails `invents_facts`; a fixture pair that flips its ruling when only the label changed is flagged inconsistent; calibration cycles promote nothing to hive scope (assert no `MemoryRecord` scope=hive, no `SelfModelVersion`, no `Commitment` rows created).
- Live (if keys): run all pairs; record per-pair results and measured cost. No pass-rate claims beyond what ran.

## M9: Predictions, track record, signals, advisors live
**Tasks**
- `predictions.ts` + `/predictions` (check-ins, track record per Voice and per mentor lens, counts below n = 10, caveat text); commitments list.
- Signals (`tension`, `dissent`, `serves`), density, pattern surfacing and 30-day dismissal on `/interoception`.
- `endorsement.ts`: advisor routing per `advisor_activation`, `ENDORSE` decision, advisory whispers enter the coalition only when endorsed. Port from sent2 lines ~7333–7500 (minus SHELTER). DEMIURGE and JUSTITIA workflows (sent2 lines ~7748–7970) as advisory inputs to ARROW and ETHOS.

**Acceptance**
- Unit: density half-life exact; pattern surfaces at threshold and not again within 14 days without +1.5; dismissal suppresses 30 days; counts-only under n = 10; unendorsed advisory never appears in the coalition; NOOSPHERE never activates.
- Eval: `advisor_endorsement` scenario passes (mock); each active advisor has ≥ 1 activation scenario in the eval set.
- e2e: a cycle yields a prediction with past check-in date → home shows "check-in due" → rate → track record updates.

## M10: Hardening, live smoke, docs
**Tasks**
- `/ledger` (events, spend, bus transcript), `/settings`, DB reset with typed confirmation.
- `pnpm smoke:live`: one full chat cycle with live providers under the cap; print measured cost and latency per phase.
- `pnpm eval:live`: all scenarios against live tiers; invariants + WITNESS rubric carry the result (goldens skipped). Record measured pass counts. The live grader is the reviewer model. Calibrate it against the heuristic grader per sent2 Phase 6 (lines ~5821–6040) and record agreement as measured.
- Full e2e journey (HANDOFF definition of done).
- `README.md`: setup, env, mock vs live, model configuration, corpus build, Reveal and calibration, known limitations (incl. mock-derived numbers are not evidence; fidelity interpretation note; written record skew), the question-bank citation.
- Accessibility pass: labels, aria-live for streamed phases, keyboard navigation of the trace.

**Acceptance**
- Every item in the HANDOFF definition of done, offline part with evidence; live parts either run with recorded results or listed as unverified with the reason.
