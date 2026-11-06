# Mentor Hive

A local simulation of one mind made of cooperating parts. Fifteen "Voices" (each an LLM agent with one human attribute, such as courage or care) think together in a fixed cycle and answer as one Hive. Each Voice's attribute comes only from verified writings of the historical mentors assigned to it (public-domain texts from Project Gutenberg and Wikisource). A mentor quote reaches the screen only if code has checked it word for word against a stored passage.

**In plain words:** you talk to the Hive, and you can open every step of how it reached its reply: which Voices spoke, what they quoted, how they voted, and what the reply was checked against. You choose which mentors shape which Voice, and you approve the Hive's constitution. The Hive also takes 40 moral dilemmas, so you can compare what it says it values with how it actually chooses.

It is a simulation. Nothing here claims the Hive is conscious, and nothing claims to say "what a mentor would think."

The build plan, specs, and decisions are in `HANDOFF.md`, `ADAPTATION_NOTES.md`, and `docs/`. `PROGRESS.md` records what was built in each milestone (M0–M10) and what was measured.

## Setup

```
pnpm install
pnpm exec playwright install chromium
cp .env.example .env              # fill in your OpenRouter key and model IDs
pnpm db:migrate && pnpm db:seed   # creates dev.db (SQLite) with Voices, mentors, dilemmas
pnpm dev                          # http://localhost:3000
```

Node 22 or later (built and tested on Node 24) and pnpm. Everything runs on this machine; the only outside service is OpenRouter, and only in live mode.

## Environment variables (`.env`, never committed)

| Variable | What it does |
|---|---|
| `DATABASE_URL` | SQLite file, default `file:./dev.db` |
| `OPENROUTER_API_KEY` | One key for every cloud model. Limit spend with OpenRouter's per-key limit; the app has no spending cap of its own. |
| `OPENROUTER_DEC_MODEL_1`, `_2`, … | Decision models (probability answers to yes/no, score, and choice questions), tried in order |
| `OPENROUTER_REVIEWER_MODEL` | The central model: writes all text, orders the cycle (manager), and grades live evals |
| `OPENROUTER_EMB_MODEL_1`, … | Embedding models (corpus, retrieval, coherence) |
| `OPENROUTER_RETRIEVAL_MODEL_1`, … | Rerank models |
| `TIER_FAST_MODEL`, `TIER_STANDARD_MODEL`, `TIER_PREMIUM_MODEL` | Optional; empty means the reviewer model |
| `PROVIDER_MODE` | `cloud` (OpenRouter) or `local` (`LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_EMBED_MODEL`) |
| `USE_MOCK_PROVIDERS` | `true` forces scripted mock providers (tests set this) |

Model IDs always come from you. The code never hard-codes one.

## Model and behaviour configuration (`config/hive.yaml`)

- `models: { manager, fast, standard, premium, grader, embedding, rerank }` overrides `.env` for one experiment. Leave it empty to use `.env`.
- `orchestration.mode: manager` lets the central model choose the next phase among those code allows. `code` uses the fixed order.
- `advisors.enabled` turns the 15 advisors on or off. On, a live cycle runs up to 14 extra advisor calls.
- `edict_module.enabled` and `honesty_clause.enabled` turn those modules on or off. The Honesty Clause applies to chat cycles only.
- Thresholds (`decision_thresholds`, `thresholds`, `signals`, `corpus.activation`) are all here. None is in code.

`/settings` shows what is in effect: model IDs and where each came from, the toggles, and measured spend. It never shows the key.

## Mock and live

**Mock** (`USE_MOCK_PROVIDERS=true`): every model call returns a scripted fixture from `tests/fixtures/llm/` or a labeled rule. These outputs test the pipeline, permissions, and invariants, not model behaviour. Every mock result is labeled on screen ("Mock providers: scripted outputs, not model behavior") and in reports. **Numbers from mock runs are not evidence about the Hive.**

```
pnpm lint && pnpm typecheck && pnpm test && pnpm eval && pnpm test:e2e     # all offline, no key needed
```

- `pnpm test` runs the vitest unit tests.
- `pnpm eval` runs the 32 mock scenarios. Two runs give byte-identical reports.
- `pnpm test:e2e` runs Playwright on port 3100, with its own build folder `.next-e2e` and `e2e.db`, so it never touches your running `pnpm dev` or `dev.db`. The last test, `zz-journey`, drives the whole operator journey: reset → Formation → constitution → chat with trace → Reveal over 40 dilemmas → prediction → check-in → track record → ledger.

**Live** (OpenRouter, costs money; every cost shown is measured from OpenRouter's reported usage):

```
pnpm smoke:live          # one full chat cycle on a copy of dev.db; per-phase cost and latency → reports/smoke-live.md
pnpm eval:live           # all scenarios on live models; invariants + live rubric; grader agreement → reports/eval/
pnpm reveal --live       # the 40 dilemmas on dev.db (or the Run Reveal button on /reveal); resumable
pnpm eval:calibration --live   # moral-calibration pairs on dev.db (or /calibration) → reports/calibration.md
pnpm dev:repl --live     # chat in the terminal
pnpm verify:live         # one call to each configured model, to check keys and IDs
```

`smoke:live` and `eval:live` never write `dev.db`. Reveal and calibration write their results to `dev.db` because that is where `/reveal` and `/calibration` read them.

## Building the mentor corpus

```
pnpm corpus build --mentor all     # fetch → chunk → embed → principles → answers → fidelity → activate
pnpm corpus build --mentor seneca --steps answers,activate
pnpm corpus status
```

Sources are listed in `seed/corpus_sources.json`. Each one was confirmed public domain in the USA from its Project Gutenberg record, except Seneca, which comes from Wikisource. A mentor becomes active when the texts give at least 30,000 authorial words, 8 principles with 2 verified quotes each, and evidenced answers to at least 13 of the 40 dilemmas (`config/hive.yaml: corpus.activation`). The fidelity report is `reports/mentor_fidelity.md`.

## Pages

| Page | What it is for |
|---|---|
| `/hive` | Talk to the Hive. "Show thinking" opens the full trace; its "Jump to" links move keyboard focus section by section. |
| `/formation` | Which mentors shape which Voice. You approve each version. |
| `/constitution` | Draft principles from the approved formation, each with a verified quote. You edit and approve; the Hive never changes it. |
| `/reveal` | 40 dilemmas: the Hive against its mentors, each Voice against its own mentors, and the Hive against its constitution |
| `/calibration` | Matched pairs that change one fact. These test consistent reasoning, not a right answer. |
| `/predictions` | Predictions the Hive made, check-ins when they come due, and a track record (counts only below 10) |
| `/interoception` | Affect and coherence over time, commitments, ego audits, recurring-pattern cards, and the voting-bloc audit |
| `/ledger` | Every model call and decision: cost, latency, probabilities; the bus transcript per cycle |
| `/settings` | Models and toggles in effect, measured spend, and the database reset |

**Reset** (`/settings`): type `reset hive state` to confirm. It first writes a copy of the database file to `backups/`. It then deletes everything the Hive accumulated by running: sessions, cycles, memory, Self-Model versions (back to v1), commitments, predictions, signals, and Reveal and calibration results. It keeps the corpus, the seed data, your approved formation and constitution, and the ledger. The ledger is append-only, and the reset itself is recorded in it.

## Known limitations

- **Mock numbers are not evidence.** Anything produced with mock providers shows that the machinery works, not how the Hive behaves.
- **Fidelity is not "what the mentor would think."** Famous figures are in the base model's training data, so a high name-only score means the model already knows them. The fingerprint's value shows up as grounding (every answer cites verified passages) and as abstaining when the texts do not address a case. All fidelity numbers are k of n on small sets.
- **Written-record skew.** The mentors are people whose writing survived and is digitized in English: mostly Western, mostly 18th–20th century, and only those whose texts are public domain. The Hive inherits that skew. Some mentors stay inactive for lack of text (Confucius, Laozi below 30,000 authorial words; Osler's source unavailable; Douglass and Nightingale below 13 evidenced dilemmas).
- **Small numbers.** The track record and Reveal comparisons show counts, not rates, below n = 10, always with "Small numbers, many other factors. A hint, not a verdict."
- **Single operator, localhost only.** No login, and the API has no auth. Do not expose the port.
- **Removed on purpose.** There is no crisis or safety gating of any kind (owner decision). The Hive is not a support service.
- **Cost is not capped in the app.** Use OpenRouter's per-key limit. Live costs are measured per call and shown in `/ledger`.
- **Phase streaming.** A chat cycle returns when it finishes. Its phases are not streamed live; the status line tells screen readers that the Hive is working.

## Credits

- The Hive design follows `reference/sent2.md`. The mentor method follows the *A Better Me: Council* handoff.
- Mentor texts come from Project Gutenberg and Wikisource, all public domain in the USA.
- **Question bank:** `seed/question_bank_subset.json` is a subset of `Thousand_Questions.txt` from deesatzed/Genesis_Prime (`apps/option1_mono_agent/Prior_QA_Parts`). According to the project owner, the question list comes from an academic open-source publication. The formal citation is still an open owner item: the file's `citation` field reads `TODO(owner)`.
