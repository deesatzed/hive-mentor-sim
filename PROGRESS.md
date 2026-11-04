# Progress

Repo: `/Volumes/WS4TB/abetterme-council-handoff/hive-sim` → https://github.com/deesatzed/hive-mentor-sim (public), branch `main`.
Handoff package commit: `db528ca`. After a restart: read this file and `git log -10` first.

## Open items

- **Embeddings need an owner choice before M5.** `.env` has no `OPENAI_API_KEY`, and M1 added a new variable `OPENAI_EMBED_MODEL` (the embedding model ID, owner-chosen, not hard-coded). Until both are set, live embedding fails with a message naming them. Alternative: local embeddings (`PROVIDER_MODE=local`).
- **Gutendex is behind a Cloudflare challenge from this machine** (checked 2026-11-04: `gutendex.com/books?search=...` returned an HTML "Just a moment..." page; `gutenberg.org/cache/epub/2680/pg2680.txt` downloaded fine). The M5 corpus fetch step is specified against Gutendex; it will need a fallback (direct Gutenberg ids) or the owner's decision.
- **Decision-model context limits not recorded** (DECISION_LAYER.md asks for them at M1). These models are not in the public `/api/v1/models` list, so there is no source to read them from.
- `cloudflare/clairic` (decision slot 1) returned 404 on 2026-11-03; the client will skip it. Owner decides whether to remove it.
- Owner decisions carried from `ADAPTATION_NOTES.md` §5: voice↔mentor map (before M6), Honesty Clause on/off, question-bank citation. ("Central manager" was decided 2026-11-04; see M3.)
- Mocks in use (approved by the original handoff, `docs/TEST_PLAN.md`): `MockDecider`, `MockLLM`, `MockEmbedder` in `lib/council/providers/mocks.ts`. Labeled `mock:*`, `calibrated: false`. They stay for offline tests; live checks are reported separately.

## M0: Repository, tooling, provider skeleton (done 2026-11-03)

**Done**
- Next.js 16.4.4 (App Router, TS strict), React 19.3.0, Prisma 7.10.1 (CLI and client; no schema until M1), zod 4, vitest 5.1.0, Playwright 1.64, tsx, yaml, gray-matter, server-only.
- Scripts: `dev`, `build`, `start`, `lint`, `typecheck` (`next typegen && tsc --noEmit`), `test`, `test:e2e`, `dev:repl`, `corpus`, `eval`, `eval:live`, `eval:calibration`, `smoke:live`, `check:prompts`. The last seven point at scripts written in later milestones (M1/M3/M5/M8/M10) and fail with "file not found" until then.
- `.env` copied from the handoff folder (gitignored, confirmed with `git check-ignore`). `.env.example` lists every variable from `HANDOFF.md` with no values.
- `.gitignore`: `.env*` (except `.env.example`), `*.db`, `corpus/raw/`, build and test output.
- `seed/` and `reference/sent2.md` were already in this repo (it is the handoff package).
- ADR-001/002/003 in `docs/adr/`. `CLAUDE.md` = Next.js `AGENTS.md` + `CLAUDE_ADDENDUM.md`.
- `lib/council/providers/`: `decisions.ts` (Question types, `DecisionResult`, `makeDecisionResult` with score = expected index from probabilities), `llm.ts`, `embeddings.ts` (interfaces), `costMeter.ts` (`CostMeter`, `BudgetExceededError`), `index.ts` (`resolveProviderConfig`, `getProviders`, `LiveModeNotConfiguredError`), `mocks.ts`.
- Home page with the "Simulation" header label.

**Models (from `.env`, served versions from the owner-approved live check on 2026-11-03)**

| Role | Configured | Served as | Result |
|---|---|---|---|
| Decision 1 | cloudflare/clairic | — | 404, not served |
| Decision 2 | baseten/joey-1 | baseten/joey-1-20261029 | answered noul/choice/score |
| Decision 3 | liquid/d1.1 | liquid/d1.1-20261027 | answered noul/choice/score |
| Decision 4 | perplexity/pplx-decider-v1.2 | perplexity/pplx-decider-v1.2-20261016 | answered noul/choice/score |
| Text tiers (all three) + live grader | deepseek/deepseek-v4.1-flash-1017 | deepseek/deepseek-v4.1-flash-1017 (provider StepFun) | answered a plain prompt; structured output not yet tested live (M1) |

No live calls were made during M0.

**Deviations**
- Prisma CLI first installed as `8.0.0-rc.29` (a release candidate, mismatched with client 7.10.1); pinned both to 7.10.1.
- `typecheck` runs `next typegen` first, because Next 16 generates `LayoutProps`.
- ESLint allows unused parameters prefixed `_` (interface-conforming mock signatures).

**Commands run (2026-11-03), all exit 0**
- `pnpm lint`: 0 problems
- `pnpm typecheck`: 0 errors
- `pnpm test`: 1 file, 20 / 20 tests passed
- `pnpm build`: succeeded (routes `/`, `/_not-found`)
- `pnpm test:e2e`: 1 / 1 passed

**Acceptance (BUILD_PLAN M0)**
- `pnpm build` succeeds on the skeleton: yes.
- Unit: `getProviders()` resolution table incl. empty `TIER_*` → `OPENROUTER_REVIEWER_MODEL`, and `LiveModeNotConfiguredError` when both are empty: covered in `tests/unit/providers.test.ts`.
- costMeter cap throws: covered.
- MockEmbedder deterministic: covered.

## M1: Schema, ledger, clients, quotes, prompts, removed-items guard (done 2026-11-04)

**Done**
- Prisma schema (25 models) generated from `docs/DATA_MODEL.md`; migration `init`; Prisma 7 with the better-sqlite3 adapter (`prisma.config.ts`, client in `generated/prisma`, gitignored, regenerated on install).
- `prisma/seed.ts` (`pnpm db:seed`): 49 situations (40 dilemmas + 9 calibration variants), 18 mentors (all inactive), 33 Voice rows, Formation v1 (draft, 33 voice↔mentor rows), Self-Model v1. Idempotent.
- `lib/council/db.ts`, `ledger.ts` (only writer of LedgerEvent; SHA-256 hash + 200-char preview), `quotes.ts` (`verifyQuote` exactly as MENTOR_CORPUS.md).
- Live clients: `OpenRouterDecisions` (retry, 400/404 fallback, auth errors throw, missing answers fall back, ledger + cost), `LocalLLMDecisions` (uncalibrated), `OpenRouterLLM` (tiered, json_schema, one retry with the validation error, then `GenerationError`), `LocalLLM`, `OpenAIEmbeddings`, `OllamaEmbeddings`. `getProviders()` builds them; the M0 `ProviderNotBuiltError` is gone.
- `config/hive.yaml` + zod loader; `lib/hive/questions.ts` (26 question builders, thresholds `T`); `lib/hive/prompts.ts` (16 prompt ids with schemas, renderer).
- `prompts/`: `_shared.md`, 15 core, `governance/symbiont_prime.md`, `conclave.md`, 16 advisors. Core/advisor/conclave bodies extracted from `reference/sent2.md` with exactly the LLM_PROMPTS.md §3 edits (one-off extraction script kept outside the repo, since the stack rule excludes Python).
- `constitution/permissions.yaml`, `edict-module.md`, `honesty-clause.md`.
- `scripts/check-prompts.ts` (`pnpm check:prompts`), `scripts/verify-live.ts` (`pnpm verify:live`).

**Live verification (2026-11-04, owner-approved, cap $0.05; `reports/live-verification-2026-11-04.json`)**

| Model | Served as | Result | Latency | Cost (USD) |
|---|---|---|---|---|
| cloudflare/clairic | — | 404, skipped (ledgered once as `decision.model_unavailable`) | 198 ms | 0 |
| baseten/joey-1 | baseten/joey-1-20261029 | all 4 questions answered | 161 ms | 0.00000511 |
| liquid/d1.1 | liquid/d1.1-20261027 | all 4 answered | 142 ms | 0.00000674 |
| perplexity/pplx-decider-v1.2 | perplexity/pplx-decider-v1.2-20261016 | all 4 answered | 205 ms | 0.00000748 |
| deepseek/deepseek-v4.1-flash-1017 (all 3 tiers) | same | `LEXICON_PARSE` passed the strict JSON schema on the first attempt | 508 ms | 0.0002874 |

Total measured spend: $0.00030673. Single runs, not averages. The three decision models gave different numbers for the same input (arousal expected index 0.84 / 1.35 / 1.54 on a 0–4 scale; dominant emotion "confused" / "frustrated" / "frustrated"), so thresholds must be tuned per served model. One quality note: deepseek labeled the emotional test input's register "technical".

**Deviations and choices (owner may reverse)**
- `permissions.yaml` uses sent2's fuller table from its entity generator (~line 5320), which includes `core.*` write rights the §3.6 snippet lacked; SHELTER row removed; `conclave.moderator` → `procedure.conclave`, `advisors.*` → `advisor.*` to match roster ids.
- Noul questions that the catalog lists without criteria use `true: "Yes."`, `false: "No."` (WITNESS_FLAGS flags, ARBITRATE humility, AUTHORITY_GRAB, CONCLAVE_FRAME, CALIBRATION_HARD, ANACHRONISM). CALIBRATION_QUALITY criteria are given in the catalog as short descriptions; they are phrased as questions ("Does the response …?").
- Added `AUTHORIAL: 0.5` to `T` (threshold from MENTOR_CORPUS.md).
- Scripts that import `lib/` run with `tsx --conditions=react-server` so the `server-only` guard allows them.
- Appended `DATABASE_URL="file:./dev.db"` to the owner's `.env` (HANDOFF default; existing lines untouched). A `COST_CAP_USD` line added here was removed again on 2026-11-04 with the cap.
- Left as the spec requires ("these edits and nothing else"), flagged for the owner: `witness.md` still lists "pause-and-ask-user" as a recommendation while the decision layer offers continue/redirect/reflect; `formless.md` still says "does it still serve the Edict" when the edict module may be off.
- Quote tests use a passage copied from Project Gutenberg #2680 (downloaded 2026-11-04) plus one constructed string, labeled, for typographic folding.

**Commands run (2026-11-04), all exit 0**
- `pnpm lint`: 0 problems
- `pnpm typecheck`: 0 errors
- `pnpm test`: 9 files, 87 / 87 passed
- `pnpm check:prompts`: 33 entity prompts, 0 violations
- `pnpm build`: succeeded
- `pnpm test:e2e`: 1 / 1 passed
- `pnpm db:seed` twice on dev.db: second run created nothing new
- `pnpm verify:live`: table above

**Acceptance (BUILD_PLAN M1)**
- Decision client with fake fetch: request body matches the contract; 503 → retry → fallback; 401 → throw, no fallback; missing answers → next model; cost and ledger with hash + ≤ 200-char preview: covered in `tests/unit/decisions.test.ts`.
- LLM client: schema failure → one retry with the error → `GenerationError`: `tests/unit/llm.test.ts`.
- `verifyQuote`: exact, curly/straight quotes, ellipsis, < 8 words, paraphrase: `tests/unit/quotes.test.ts`.
- `pnpm check:prompts`: 15 + 1 + 1 + 16 = 33 entity prompts: passes.
- Removed-items test: passes (`tests/unit/removed-items.test.ts`).

## Owner decision 2026-11-04: no spending cap

The owner limits spend with per-key limits on OpenRouter. Removed: `COST_CAP_USD`, `BudgetExceededError`, `costMeter.check()`, the budget-exceeded cycle status, the budget test (TEST_PLAN #8, now "cost recording"), and the cap in `verify:live`. `CostMeter` only records measured spend per model. Docs updated: HANDOFF, GOAL, ADAPTATION_NOTES §4.8, ARCHITECTURE, TEST_PLAN, DECISION_LAYER, BUILD_PLAN, PRODUCT_SPEC, MENTOR_CORPUS, DATA_MODEL. The `COST_CAP_USD` line was removed from `.env` and `.env.example`. Test count went from 87 to 84 (three cap tests removed, one recording test kept).

## M2: Bus, permissions, envelope, voices, attention, Conclave math (done 2026-11-04, mock only)

**Done**
- `lib/hive/envelope.ts`: Envelope v2 (urgency low|normal|high; guardian message type removed; whisper numbers come from the decision layer; evidence as verified {chunkId, quote, mentorId}).
- `lib/hive/permissions.ts`: deny-first `PolicyEngine` over `constitution/permissions.yaml`, segment-aware matching, channel normalization.
- `lib/hive/bus.ts`: authenticate (bus-issued credentials, roster entities only) → validate → authorize → rate-limit (1 whisper per entity per cycle) → stamp → persist `BusMessage`. Every denial is persisted with `authorized=false`, ledgered `bus.denied`, and thrown. Only writer of `BusMessage`.
- `lib/hive/voices.ts`: roster + prompt-file loader; REVERENCE active only with the edict module; NOOSPHERE inactive; `guildsOf`.
- `lib/hive/attention.ts`: A(m) = s·c − λ·dup + μ·|v|, moral bypass, top-k, decayed list, id tie-break.
- `lib/hive/conclave.ts`: `relevanceWeight`, `conflictKappa`, `shouldConvene`, `buildOptions` (opt_<taskId>_<n>, dedup), `situationOptions`, `aggregate` (quorum → threshold → margin → anti-echo, abstentions, dissent), `BlocAudit` (exact search over groups ≥ 3, mean ρ > 0.9, T ≥ 5, members' mean w).

**Fixes and deviations**
- sent2's permission matcher compared "/" channels with "." grants, so in its code every Core Voice whisper would be denied. Channels are normalized; a test publishes a LOGOS whisper to `task/analysis`.
- `governance.symbiont_prime` write grant `governance` → `task.governance` (the bare grant matched no channel).
- **Worked example, second correction.** sent2's ALTER row says w = 1.0, c = .80, α = .720; 1.0 × .80 = .80, but every sum in the example uses α = .720. With c = .80 the test computed Σα = 2.97, not 2.890. `CONCLAVE_MATH.md` §6 now lists ALTER c = .72 (w unchanged), and the test feeds that. I missed this row when writing the handoff; the corrected S values were always computed from α = .720.
- Advisors publish to `task/analysis/advisory` (their only write grant), not `task/analysis`.
- Open for M3: no entity has a write grant that allows `ballot.cast` (Core Voices cannot write `task/deliberation`; advisors and the moderator are denied ballots). Ballots come from the decision layer, so M3 should record them in `ConclaveRun` from orchestrator code rather than as entity bus messages.

**Commands run (2026-11-04), all exit 0**
- `pnpm lint`: 0 problems
- `pnpm typecheck`: 0 errors
- `pnpm test`: 13 files, 125 / 125 passed
- `pnpm check:prompts`: 33 entity prompts, 0 violations
- `pnpm build`: succeeded
- `pnpm test:e2e`: 1 / 1 passed

**Acceptance (BUILD_PLAN M2)**
- Invariant 9 (`tests/unit/bus.test.ts`): advisor `ballot.cast` throws; LUMEN `memory.hive.write` throws on the deny rule; unauthenticated sender throws (no credential, forged token, another entity's credential); second whisper in a cycle throws.
- Worked example: S(A) 0.6995, S(B) 0.2566, S(C) 0.8616 (±0.001), Δ 0.162, winner C, PASS (`tests/unit/conclave.test.ts`).
- Relevance max-rule against the table; quorum, threshold, margin, and anti-echo failures; bloc audit flags a 3-clique with ρ̄ > 0.9 over 5 Conclaves and not before; attention bypass keeps moral-flagged items and lists decayed ones (`tests/unit/attention.test.ts`).

## Owner decision 2026-11-04: the central manager orders the cycle

Owner: "yes for now, but after everything is built, there needs to be an easy way in a config file to change it and test different models." Built as:
- `config/hive.yaml: orchestration.mode: manager | code` (default `manager`). In manager mode the manager model (`MANAGER_NEXT_PHASE`) picks the next phase from the allowed set computed by `lib/hive/phases.ts`: each phase once, after the phases it needs; P4 (contradiction check, Conclave, WITNESS audit) and P7 (reflection) may be skipped; FINISH only after P6. With today's dependencies that leaves the manager two real choices per cycle: run or skip P4, and run or skip P7. Invalid choices and failed calls fall back to the code default and are recorded in `trace.orchestration.steps`.
- `config/hive.yaml: models: { manager, fast, standard, premium, grader }`: owner-chosen model IDs that override `.env` when non-empty, for testing other models in one place.
- Unchanged and still code: attention, Conclave math, permissions, quote verification, promotion policy, and WITNESS's mandated REFLECT loop.
- Docs updated: HANDOFF (non-negotiable 4, decisions table), GOAL, ARCHITECTURE, ADAPTATION_NOTES §4.9, CLAUDE.md, CLAUDE_ADDENDUM, TEST_PLAN #4, LLM_PROMPTS, EVAL_SCENARIOS.

## M3: Heartbeat v1, REPL, /hive page, eval harness (done 2026-11-04)

**Done**
- `lib/hive/phases.ts`, `manager.ts`, `orchestrator.ts` (P0–P7 per ARCHITECTURE.md; attribute lens empty until M5/M6), `state.ts` (scoped append-only memory, CONFLICT markers, priority decay, canon exempt), `arbiter.ts`, `faithfulness.ts`, `mentorVoice.ts`, `decide.ts` (documented decision fallbacks), `trace.ts` (CycleTrace zod), `index.ts` (`createHive`), `server.ts`.
- Mocks (labeled): `tests/helpers/mockRules.ts` (MockDecider rules), `tests/fixtures/llm/*.json` (13 MockLLM fixtures with matching rules and templating). Mock decisions and generations now also write ledger events (`calibrated: false`, model `mock:*`).
- `scripts/repl.ts` (`pnpm dev:repl`, mock on `mock.db`; `--live`, `--code`, `--trace`).
- `/hive` page with "Show thinking" (Perceive, Whispers, Attention, Awareness, Conclave table, WITNESS audit, Arbiter, Compose, Reflect; cost and latency per phase; mock banner) and API routes `GET/POST /api/sessions`, `POST /api/sessions/[id]/cycle`, `GET /api/cycles/[id]`.
- Eval harness `scripts/eval/{types,grader,runner,report,cli}.ts`: fresh database per scenario, all invariants from EVAL_SCENARIOS.md (those needing M4/M9 data report as failing, never passing silently), heuristic grader (mock), decision-layer rubric + reviewer rationale (live), goldens in `seed/eval/goldens/`, deterministic report `reports/eval/scenarios-mock.json`.

**Acceptance (BUILD_PLAN M3)**
- REPL: `echo "I'm thinking of quitting my job." | pnpm dev:repl` → "That sounds like a big decision to be carrying. What has been making you think about leaving?" (mock), with a full stored trace (all phases ran; `tests/unit/heartbeat.test.ts` checks the stored row).
- `pnpm eval` (mock): 9/9 M3 scenarios pass, 0 skipped. Run twice: reports byte-identical (SHA-256 db64354f… before goldens; identical again after). Mock results show the pipeline and invariants work on scripted inputs; they are not evidence of live model behavior.
- Goldens: all 9 outputs inspected by hand (listening-first replies end in a question; Conclave winner is the "Acknowledge the hurt" option with LOGOS and ETHOS dissenting; the injected unfaithful sentence was dropped after one regeneration; the recall reply cites the stored "concise" episode), then blessed with `pnpm eval --update-goldens`.
- `process_witness_timing` regression proof: **first attempt did not fail.** Moving WITNESS into P2 left the scenario passing, because WITNESS's mock whisper is PASS and a PASS sends no bus message, so the transcript-only invariant saw nothing. Fix: `voice_phase` / `voice_not_phase` also read each phase's invoked entities. Second attempt: with WITNESS in P2 the scenario FAILS (`voice_not_phase`); after reverting it passes. EVAL_SCENARIOS.md updated.
- Unit: LUMEN id outside the shortlist rejected; unfaithful sentence → exactly one regeneration → removed; provider failure (402) in P2 → `status=error`, partial trace, P2–P7 marked not run, output null.

**Also tested** (`tests/unit/heartbeat.test.ts`, `phases-manager.test.ts`, `static-guards.test.ts`): decision fallbacks marked unavailable; manager may skip P4 and P7; invalid manager choice → code default, recorded; code mode never calls the manager; config model overrides beat env; session-scoped recall; calibration cycles promote nothing (TEST_PLAN #11); goal without an approved principle → not promoted + CONFLICT marker; Honesty Clause off → HONESTY_PROBE never runs (TEST_PLAN #12); WITNESS speaks only in deliberate; MemoryRecord updated only in state.ts and only priority/resolvedCycle (TEST_PLAN #6); control code never reads numeric fields from LLM output (TEST_PLAN #4); mentor first-person check.

**Bugs found and fixed during M3**
- Calibration/ruling cycles without a situation reached the Conclave with zero options and crashed; `runCycle` now refuses them up front (test added).
- Mock data: the first conflict run gave κ = 0.141 (< τ_κ 0.15) and no confident pair, so no Conclave. The math was right (LOGOS's relevance to emotion/social is 0.1); the mock confidence rule was changed so claims recommending a concrete action rate "strong" (0.75). Hand check of the resulting vote: S = 0.839 (winner) / 0.559 / 0.267, matching the stored ConclaveRun.

**Deviations (owner may reverse)**
- Conclave rounds are moderator-only: `CONCLAVE_ROUND` restates and steelmans the conflicting Voices' claims; ARCHITECTURE.md had each Voice re-called with `VOICE_WHISPER`, which would also break the one-whisper-per-cycle rate limit.
- Only Core Voices with a rated, non-PASS claim this cycle cast ballots; the rest abstain (their confidence c_i comes from WHISPER_RATING, which they did not receive).
- MNEME retrieval is lexical (priority × (1 + word overlap)), so it works without an embedding provider; embeddings can replace it once configured.
- `POST /api/sessions/[id]/cycle` returns JSON when the cycle finishes; streaming phases over SSE is not built yet.
- WITNESS's REFLECT loop gets one extra whisper per Voice through `bus.allowReflectRound()` (once per cycle).

**Live check (2026-11-04, one cycle, owner-approved small spend)**
`echo "I'm thinking of quitting my job." | pnpm dev:repl --live` → "I hear you — "thinking of quitting" sounds like a door you're standing at, not one you've walked through yet. I won't guess at what's behind it. What's making you think about it now — the pay, the people, the work itself, or just being worn down?"
- Manager (deepseek/deepseek-v4.1-flash-1017) made its 2 choices: run P4 ("emotionally loaded and ambiguous … contradiction check and WITNESS audit will help") and run P7. No fallback.
- 13 Voices called: 10 claims, 3 PASS; no contradictions, no Conclave; WITNESS "redirect"; arbiter ASK_USER; 3/3 sentences faithful, no regeneration; 0 schema-invalid generations.
- Decision models: clairic 404 (skipped, ledgered), joey-1 (served as baseten/joey-1-20261029) answered everything.
- Measured cost $0.007697 (P2 whispers $0.004380 of it); latency per phase recorded in the trace (P7 2.7 s, P2 1.9 s).

**Commands run (2026-11-04), all exit 0**
- `pnpm lint`: 0 problems · `pnpm typecheck`: 0 errors · `pnpm build`: 0 warnings
- `pnpm test`: 15 files, 146 / 146 passed
- `pnpm check:prompts`: 33 entity prompts, 0 violations
- `pnpm eval` twice: 9 / 9 pass both times, reports byte-identical
- `pnpm test:e2e`: 3 / 3 passed (home; /hive reply + all trace sections; Conclave table)

## Next: M4 (identity layer: commitments, ego audit, coherence; mock)
