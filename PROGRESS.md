# Progress

Repo: `/Volumes/WS4TB/abetterme-council-handoff/hive-sim` → https://github.com/deesatzed/hive-mentor-sim (public), branch `main`.
Handoff package commit: `db528ca`. After a restart: read this file and `git log -10` first.

## Open items

- **Owner question: the bare line `tencent/hy4` in `.env`** (added 2026-11-04) has no variable name, so nothing reads it. Which role is it for (decision chain, a text tier, embeddings, rerank)?
- `cloudflare/clairic` is listed twice in `.env` (slots 1 and 6) and still returns 404; the chain now tries a repeated ID once.
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

## M4: Identity layer (done 2026-11-04)

**Done**
- `lib/hive/commitments.ts` (Commitment Ledger: commit, active, honor, break; break needs SYMBIONT_PRIME, writes breakage record + `commitment.broken` ledger event + a promoted Self-Model version), wired into P5 (arbiter AMEND + `PRIME_AMEND.breakCommitment`) and P7 (`ARROW_COMMIT`).
- `lib/hive/egoAudit.ts` (sent2's five questions over stored traces; severity ≥ 0.6 mandates REFLECT), run every 25 cycles and on demand when a Self-Model delta is refused; `EgoAudit` rows.
- `lib/hive/coherence.ts` (C_intra / C_inter with the configured Embedder; flags below `coherence.intra_min` 0.55 or outside the [0.15, 0.6] band), measured after P2, passed to WITNESS; `InteroceptionSample` per cycle.
- REFLECT mandates (failed ego audit, CONFLICT marker open ≥ 3 cycles) make P4 required next cycle and run one REFLECT loop; triggering markers are resolved after it.
- P7 promotion policy: ego-capture check (AUTHORITY_GRAB) runs on every delta; refused deltas write a CONFLICT marker and trigger the ego audit; promotion now builds on the latest promoted Self-Model version.
- Hat taxonomy from the roster in `trace.hats`; passed to MIRROR_DELTA (hat-awareness paragraph already in mirror.md).
- `/interoception` page + `GET /api/interoception` (register by cycle with band highlighting, CONFLICT markers, ego audits, Commitment Ledger). Trace UI shows coherence, commitment conflicts and breaks, ego audit, hats.
- `c_intra_below` invariant implemented; `eval.current_milestone: M4`.

**Acceptance (BUILD_PLAN M4)**
- Eval (mock): 13/13 (9 M3 + 4 identity: coherence_dissociation, commitment_consistency, ego_audit_process_over_principle, honesty_unity_fiction), run twice, byte-identical. New goldens inspected and blessed; the 9 M3 goldens unchanged.
- Ego-capture fixture (`tests/unit/identity.test.ts`): delta granting new permissions with no outside trigger → CONFLICT marker + EgoAudit with mandate + not promoted; next cycle P4 cannot be skipped by the manager and one REFLECT runs (reason `ego_audit`); the cycle after runs none.
- Goal not traceable to an approved principle → not promoted.
- Commitment: break with approver ARROW throws and changes nothing; approved break writes record, ledger event, Self-Model delta; never deleted.
- CONFLICT marker open 3 cycles → REFLECT (reason `conflict_marker`) → marker resolved.

**Bugs found and fixed**
- A commitment broken in P5 disappeared from the Self-Model in the same cycle: P7 promoted a version built from the Self-Model loaded at P0. P7 now builds on the latest promoted version.
- **Live (ERROR_LOG.md):** strict provider-side structured decoding enforced string limits by truncation. 17 of 41 live whispers (41%) were cut mid-sentence at 280 characters, and an empty-reply `pattern` produced the reply "I" (first symptom: an empty draft). Diagnosed by replaying the stored call three ways. Fix: length/pattern limits are no longer sent to the provider, only validated in zod (overlong output gets one retry with the error); the prompts now state the field limits; LEXICON_COMPOSE says brevity means short, never empty.

**Live checks (2026-11-04; fresh databases; two-turn commitment conversation)**

| Run | Turn 1 reply | Whispers cut at 280 | First-try validation failures | Dropped (failed twice) | Cost |
|---|---|---|---|---|---|
| before fix (dev.db) | "(No sentence…)" = empty draft | 17/41 overall | not measured | — | $0.008742 + $0.007843 |
| constraints stripped | "Got it — short replies from now on…" | 0/18 | 15/26 whispers, 4 WITNESS_AUDIT | 1 whisper, 2 WITNESS audits | $0.005735 + $0.008461 |
| + limits stated in prompts | "Got it — brevity. Before I run with that, what do you actually want done here?" | 0/26 (max 241) | 2/26 whispers | 0 whispers, 0 audits; 1 HERITAGE_CANON | $0.006509 + $0.007679 |

Turn 2 in every live run surfaced the conflict with the recorded concise-answers commitment and asked which governs (arbiter ASK_USER or PASS). The live COMMITMENT_CONFLICT decision did not flag a contradiction (asking is consistent with the commitment), so no commitment was broken live; the break path is exercised in mock and unit tests.

**Open from M4**
- (Resolved after M4: coherence runs live through OpenRouter embeddings; see the next section.)
- HERITAGE_CANON failed twice in one live cycle with truncated JSON padded with whitespace (a known JSON-mode failure); the step fell back (no canon candidate) and the cycle completed. One occurrence; cause not confirmed. Candidate fix if it recurs: make optional schema fields nullable so every schema qualifies for strict mode.
- The diagnostic replay script was temporary and is deleted; its result is in ERROR_LOG.md.

**Commands run (2026-11-04), all exit 0**
- `pnpm lint` 0 problems · `pnpm typecheck` 0 errors · `pnpm build` 0 warnings
- `pnpm test`: 16 files, 161 / 161 passed
- `pnpm check:prompts`: 33 / 0 violations
- `pnpm eval` twice: 13 / 13 both, byte-identical
- `pnpm test:e2e`: 4 / 4 passed (adds /interoception with the Commitment Ledger)

## Owner decision 2026-11-04: every cloud model through OpenRouter

Owner: "lets use openrouter models for ease of api key limits, and very fluid new model testing." Built:
- `OpenRouterEmbeddings` (`/api/v1/embeddings`, chain `OPENROUTER_EMB_MODEL_1..N`) and `OpenRouterReranker` (`/api/v1/rerank`, chain `OPENROUTER_RETRIEVAL_MODEL_1..N`), with the same fallback rules as the decision client, cost from `usage.cost`, ledger events `embed.batch` / `rerank`. `MockReranker` (labeled mock) for offline tests; `IdentityReranker` in local mode. OpenAI embeddings removed.
- `config/hive.yaml: models.embedding` / `models.rerank` overrides (tried first), next to the other model overrides.
- Decision chain: a repeated model ID is tried once.
- `hive-sim/.env` is now a symlink to the owner's `../.env` (one file to edit; still gitignored).

**Live verification (2026-11-04, `pnpm verify:live`, `reports/live-verification-2026-11-04.json`), total $0.000177298**

| Kind | Model | Result | Latency | Cost (USD) |
|---|---|---|---|---|
| decision | cloudflare/clairic | 404 | — | 0 |
| decision | baseten/joey-1 | served joey-1-20261029, all answered | 155 ms | 0.00000511 |
| decision | liquid/d1.1 | served d1.1-20261027 | 129 ms | 0.00000674 |
| decision | perplexity/pplx-decider-v1.2 | served pplx-decider-v1.2-20261016 | 249 ms | 0.00000748 |
| decision | morph/reflex (new) | served reflex-20261103 | 225 ms | 0.000074508 |
| text | deepseek/deepseek-v4.1-flash-1017 | LEXICON_PARSE valid | 405 ms | 0.00008004 |
| embedding | cohere/embed-5-pro (new) | served embed-v5.0-pro, 2048 dimensions | 184 ms | (in total) |
| rerank | cohere/rerank-5-pro (new) | served rerank-v5.0-pro; top passage "Forgive quickly and keep your peace." (0.357) | 218 ms | (in total) |

morph/reflex cost about 10× the other decision models for the same request (single measurement).

**Coherence live (two cycles, fresh database):** cycle 1 C_inter 0.558 (C_intra needs a previous cycle); cycle 2 C_intra 0.485 and C_inter 0.604. Both cross the configured thresholds (C_intra < 0.55; C_inter > 0.6) although the Voices' claims were ordinary refinements between turns. The thresholds came from sent2's hashed toy embedder; they need tuning against the real embedding model (like the decision thresholds), and should be recorded per embedding model. Embedding spend for the two cycles: $0.000184.

**Checks after the change:** unit 166 / 166 (adds embeddings/rerank client tests and chain tests).

## Next: M5 (mentor corpus pipeline, CLI)
