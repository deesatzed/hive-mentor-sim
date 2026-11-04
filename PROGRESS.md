# Progress

Repo: `/Volumes/WS4TB/abetterme-council-handoff/hive-sim` → https://github.com/deesatzed/hive-mentor-sim (public), branch `main`.
Handoff package commit: `db528ca`. After a restart: read this file and `git log -10` first.

## Open items

- **Live providers not built yet.** In cloud or local mode, `getProviders()` resolves and validates the configuration, then throws `ProviderNotBuiltError`. Remove this error in M1 when `OpenRouterDecisions`, `OpenRouterLLM` and the embedders exist.
- **No `OPENAI_API_KEY` in `.env`.** It is needed for live embeddings (corpus build, retrieval). Owner to add one or choose local embeddings before M5.
- **No `COST_CAP_USD` in `.env`.** The default of $5.00 applies.
- `cloudflare/clairic` (decision slot 1) returned 404 on 2026-11-03; the client will skip it. Owner decides whether to remove it.
- Owner decisions carried from `ADAPTATION_NOTES.md` §5: what "central manager" means (before M3), voice↔mentor map (before M6), Honesty Clause on/off, question-bank citation.
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

## Next: M1 (schema, ledger, live decision/LLM/embedding clients, quote verifier, prompts, removed-items guard)
