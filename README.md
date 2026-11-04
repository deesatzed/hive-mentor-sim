# The Mentor Hive — handoff package

A build package for an autonomous coding agent. It specifies a local simulation in which a swarm of 15 LLM agents plays one sentient AI, whose human attributes come only from verified writings of 18 historical mentors.

Derived from the *A Better Me: Council* handoff (methods) and `reference/sent2.md` (the Hive swarm design). Crisis and safety items from both were removed on the owner's instruction.

**Start here:** `HANDOFF.md`. Then `ADAPTATION_NOTES.md` for what changed and what the owner still needs to decide.

```
HANDOFF.md             entry point: mission, non-negotiables, decisions, definition of done
GOAL.md                the /goal prompt for the build agent
ADAPTATION_NOTES.md    mapping from both sources; removed items; choices; open owner items
CLAUDE_ADDENDUM.md     section to append to the new repo's CLAUDE.md
docs/                  PRODUCT_SPEC, ARCHITECTURE, DATA_MODEL, DECISION_LAYER, CONCLAVE_MATH,
                       LLM_PROMPTS, MENTOR_CORPUS, BUILD_PLAN (M0–M10), TEST_PLAN, EVAL_SCENARIOS
seed/                  mentor_roster, dilemmas, question_bank_subset (unchanged from council);
                       voice_roster, voice_mentor_map, calibration_pairs, eval/scenarios/*.yaml (new)
reference/sent2.md     the full Hive design (design reference; this package wins on conflicts)
```

## Running the app (built milestone by milestone; see `PROGRESS.md`)

```
pnpm install
cp .env.example .env                 # fill in keys and model IDs (owner-supplied)
pnpm exec playwright install chromium
pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e   # offline, mock providers
pnpm dev                             # http://localhost:3000
```

Tests and e2e run with `USE_MOCK_PROVIDERS=true` and need no API keys. Live mode reads every model ID from `.env`.

```
pnpm dev:repl                        # chat in the terminal on mock providers (scripted; db mock.db)
pnpm dev:repl --live                 # live providers from .env (costs money; cost printed per cycle)
pnpm eval                            # mock scenario suite; report in reports/eval/scenarios-mock.json
```

**Who orders the thinking cycle, and which models run:** `config/hive.yaml`
- `orchestration.mode: manager` (the central model picks the next phase among those code allows) or `code` (fixed order).
- `models: { manager, fast, standard, premium, grader }`: put an OpenRouter model ID here to try a different model; empty means use `.env`.
