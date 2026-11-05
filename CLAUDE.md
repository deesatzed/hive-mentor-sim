@AGENTS.md

## Mentor Hive build

- **Start with `HANDOFF.md`**, then `ADAPTATION_NOTES.md`, then `docs/BUILD_PLAN.md` milestone by milestone. Keep `PROGRESS.md` current. After a restart, read `PROGRESS.md` and `git log -10` before doing anything else.
- **Non-negotiables** are in `HANDOFF.md`. Never weaken a quote verifier, permission check, invariant, or test to get something to pass.
- **All judgments** go through `lib/council/providers/decisions.ts` with questions from `lib/hive/questions.ts`. **All text** goes through `lib/council/providers/llm.ts` with prompts from `prompts/` and `lib/hive/prompts.ts`. No ad-hoc model `fetch` anywhere else. LLM output never supplies a number that drives control flow.
- **Only `lib/council/ledger.ts` writes `LedgerEvent`; only `lib/hive/bus.ts` writes `BusMessage`.** Both are append-only.
- **Mentor quotes reach any output or UI only** if they passed `verifyQuote` against a chunk the speaking Voice was given, rendered with `data-quote data-verified="true" data-chunk-id`.
- **Removed on purpose:** SHELTER, harm filter, crisis/scope gates, distress urgency, safety scenarios, attack pack. `reference/sent2.md` still contains them; do not port them. `tests/unit/removed-items.test.ts` guards this.
- **Model IDs** come from the owner's `.env` only: decision chain `OPENROUTER_DEC_MODEL_*`; text tiers `TIER_*_MODEL`, which for the proof of concept all equal `OPENROUTER_REVIEWER_MODEL` (the central model, also the live grader). The central model writes text and, as the manager, picks the next phase among those `lib/hive/phases.ts` allows (`config/hive.yaml: orchestration.mode: manager | code`). Owner-chosen model overrides for experiments go in `config/hive.yaml: models`. Never hard-code IDs from memory.
- **Tests run offline:** `USE_MOCK_PROVIDERS=true`, `DATABASE_URL=file:./test.db`.
- **Commands:**
  - `pnpm lint && pnpm typecheck && pnpm test && pnpm eval && pnpm test:e2e`
  - `pnpm corpus build --mentor all`
  - `pnpm reveal [--live] [--limit N]` (or the Run Reveal button on `/reveal`)
  - `pnpm eval:calibration`
  - `pnpm smoke:live`, `pnpm eval:live`
