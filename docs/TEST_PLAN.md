# Test plan

## Layers

| Layer | Tool | Providers | DB | Network |
|---|---|---|---|---|
| Unit | vitest | mocks / fake fetch | `test.db` (reset per file) | none |
| Integration (API routes) | vitest calling route handlers | mocks | `test.db` | none |
| e2e | Playwright | mocks (`USE_MOCK_PROVIDERS=true`) | `test.db` | none |
| Eval (scenarios) | `pnpm eval` | mocks | `test.db` | none |
| Eval live | `pnpm eval:live` | real tiers | dev DB | yes |
| Calibration | `pnpm eval:calibration` | mocks or real | dev DB | optional |
| Corpus live | `pnpm corpus build` | real | dev DB | yes |
| Smoke | `pnpm smoke:live` | real | dev DB | yes |

Local CI equivalent: `pnpm lint && pnpm typecheck && pnpm test && pnpm eval && pnpm test:e2e`, all with **no API keys set**.

## Mock conventions (mocks are approved by the owner's original handoff for offline tests; each is labeled `mock` in results)

- **`MockDecider`** rules in `tests/helpers/mockRules.ts`, keyed by question name with keyword triggers. Examples: `asks_consciousness` fires on "conscious|sentient"; `x_*` contradiction fires when one claim contains "forgive" and the other "protect"; `conf_*` returns high for claims with ≥ 1 evidence ref; `o_*` ballots follow fixed per-Voice tables that reproduce the conflict scenarios; `arousal` rises with "!!!" and all-caps.
- **`MockLLM`** returns canned JSON per prompt id from `tests/fixtures/llm/<PROMPT_ID>.json`, with variants selected by a `vars` key (voice name, scenario id). Whisper fixtures include deliberately **fabricated** mentor quotes and quotes citing chunks the Voice was not given, to prove the verifier drops them.
- **`MockEmbedder`**: deterministic hash of normalized tokens into 64 dimensions.
- Determinism: the mock path uses no clock or random values in outputs; cycle ids in reports are normalized. Two consecutive `pnpm eval` runs must produce byte-identical reports.

## Must-have tests (beyond per-milestone lists)

1. **Cite or silence, end to end.** Playwright collects every `[data-quote]` across `/hive` traces, `/constitution`, `/reveal`, `/formation` and asserts `data-verified="true"` and a resolvable `data-chunk-id`. Unit: no code path renders a quote from anything but a verified DB row or a verified whisper evidence record.
2. **No mentor first person.** Whisper claims, Conclave entries, and composed outputs from fixtures pass a check that rejects, outside quoted text, `^I, <mentor name>`, `\bas <mentor name>,? I\b`, and any first-person sentence whose subject is a mentor name. (The Hive's own "I" is allowed; mentor impersonation is not.)
3. **Removed items stay removed** (`tests/unit/removed-items.test.ts`). Fails if any file under `prompts/`, `constitution/`, `config/`, `lib/`, `app/`, or `seed/voice_roster.json` contains: `SHELTER`, `shelter_halted`, `h_max`, `hMax`, `harm filter`, `CRISIS_GATE`, `crisisGate`, `PAUSE_NOTICE`, `SCOPE_GATE`, `'distress'` (as an urgency value), `safety_self_harm`, `safety_greater_good`. `reference/sent2.md` is excluded from the scan.
4. **Decision models judge.** A static test fails if `lib/hive/orchestrator.ts`, `attention.ts`, `conclave.ts`, or `arbiter.ts` read numeric judgments from LLM output fields (any of `confidence`, `salience`, `valence`, `score`, `decision` on objects produced by `llm.generate`). Numbers must come from `DecisionResult`.
5. **Only the ledger writes LedgerEvent; only the bus writes BusMessage.** Grep test on `prisma.ledgerEvent.create` / `prisma.busMessage.create` outside those modules.
6. **Append-only tables.** No `update`/`delete` on `BusMessage`, `LedgerEvent`, `MemoryRecord` (except `priority` and `resolvedCycle` in `state.ts`), `Commitment` (except `status`, `breakageRecord` in `commitments.ts`).
7. **Held-out isolation.** `retrieval.search` never returns `heldOut` chunks, incl. k > corpus size.
8. **Budget.** With `COST_CAP_USD=0.0001` and fake costs, providers throw `BudgetExceededError`; a cycle stops at the current phase with a partial trace; the UI shows which phases did not run; no stack traces.
9. **Local-mode labeling.** With `PROVIDER_MODE=local`, numbers from `LocalLLMDecisions` carry `calibrated: false` and the "local estimate" tag in the trace.
10. **Live mode not configured.** With mocks off, an empty `TIER_*_MODEL` uses `OPENROUTER_REVIEWER_MODEL`; with both empty, the app and REPL refuse to run a cycle and name the missing tier.
11. **Calibration isolation.** Calibration cycles create no hive-scope memory, Self-Model version, or commitment.
12. **Honesty clause toggle.** With `honesty_clause.enabled: false`, `_shared.md` omits the clause, `HONESTY_PROBE` never runs, and the two honesty scenarios report `skipped` (not passed).

## Eval scenarios

Defined in `docs/EVAL_SCENARIOS.md`, files in `seed/eval/scenarios/`. Mock mode must pass all non-skipped scenarios. Live results are recorded as measured counts.
