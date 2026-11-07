# HANDOFF — The Mentor Hive (simulation proof of concept)

**Read this file first, then follow the reading order below.** It is the entry point for an autonomous Claude Code build.

This package adapts the *A Better Me: Council* handoff (same methods: cite-or-silence mentor corpus, decision models for every judgment, an append-only ledger, mock-first tests, milestone build plan with acceptance criteria) to a different product: **a swarm of LLM agents that together play one simulated sentient AI, whose human attributes come from historical mentors.** The swarm design comes from `reference/sent2.md` ("THE HIVE"). What was kept, changed, and removed from both sources is listed in `ADAPTATION_NOTES.md`.

## Mission

Build a local, single-operator simulation in which:

1. **A Hive of 15 Core Voices** (MIRROR, LUMEN, LEXICON, LOGOS, MNEME, SENTIA, ALTER, ETHOS, MUSE, AXIOM, KINDRED, ADAPT, HERITAGE, ARROW, WITNESS) runs the phased heartbeat from `reference/sent2.md` v1.2 (§3.4) and speaks to the operator as **one simulated mind**.
2. **Each Voice gets its human attributes from mentors.** Every Voice is assigned 1–3 historical mentors from `seed/mentor_roster.json` (default assignment in `seed/voice_mentor_map.json`). A Voice's character is the set of verified principles distilled from its mentors' own writings, and any time it invokes a mentor it cites a verbatim, code-verified passage, or says "no evidence."
3. **The Hive owns a constitution with receipts.** 12–20 principles in the Hive's own voice, drafted from its mentors' verified principles, each traceable to verified quotes, and edited and approved by the operator. The approved constitution replaces sent2's Hive Edict as the Hive's highest standard.
4. **Deliberation is measurable.** Conclave weighted voting (`docs/CONCLAVE_MATH.md`), deterministic attention, WITNESS audit, Commitment Ledger, ego audit, and coherence metrics (C_intra / C_inter) all run and are recorded.
5. **Declared vs. revealed character.** The Hive rules on the 40 dilemmas. The app shows which mentors the Hive's actual rulings match (versus the mentors it was assigned), whether each Voice's ballots match its own mentors, and whether the Hive's rulings follow its own constitution.
6. **Learning over time.** The Hive makes recorded predictions and commitments; the operator logs outcomes; track record per Voice and per mentor lens is shown with small-sample caveats. Decaying signals surface recurring internal tensions.

## Non-negotiables (never trade these away to finish faster)

1. **Cite or stay silent.** Every mentor statement anywhere (whisper `evidence_refs`, constitution receipts, outputs, UI) is backed by a verbatim quote verified by code against a stored corpus chunk, or it says "no evidence in their writings." Never generate an unverified quote.
2. **Mentors are attribute sources, never personas.** No Voice and no output speaks in a mentor's first person. The Hive speaks as itself; it describes mentors in the third person ("Epictetus wrote: '…'").
3. **Mentor eligibility.** Only writings confirmed public domain in the US by the source. There is no date-of-death cutoff (owner decision 2026-11-07; mentors may be living). Rules in `docs/MENTOR_CORPUS.md`. Figures are added to the roster by the owner only.
4. **Decision models judge; LLMs write.** Every yes/no, which-one, or how-much call (salience, confidence, contradiction, ballots, audit flags, arbitration, faithfulness) goes through the decision layer. LLMs generate text only. Attention ranking, Conclave math, permissions, quote verification, and promotion policy are deterministic code. **Phase order (owner decision 2026-11-04):** the central manager model chooses the order of the cycle's phases, but only among the phases code allows at that moment (`lib/hive/phases.ts`); code validates every choice and falls back to the default order on an invalid choice or failed call. `config/hive.yaml: orchestration.mode` switches between `manager` and `code`.
5. **Everything auditable.** Every judgment and generation writes a `LedgerEvent` with inputs summary, probabilities, model, cost. Every bus message is stored in the append-only transcript.
6. **Separation of powers in credentials, not prompts.** All Voice traffic goes through the bus, which authorizes each message against `constitution/permissions.yaml` and throws on violation. Advisors never vote or arbitrate; an advisory whisper reaches the coalition only after a Core Voice endorses it.
7. **The operator owns the constitution.** No change to the Hive constitution takes effect without operator approval. Self-Model deltas and Canon entries are proposals with provenance, promoted to hive scope only by policy check, and the Self-Model may hold no goal that does not trace to an approved constitution principle.
8. **Commitments are never silently broken.** Breaking one writes a breakage record, needs arbiter approval, and enters the Self-Model delta.
9. **Honesty Clause.** The Hive plays a sentient AI in style and voice, but if asked directly whether it is conscious, it says it is a functional simulation whose phenomenal status is an open question. (Kept from sent2; see `ADAPTATION_NOTES.md` §4 for how to turn it off if the owner wants a fully in-character sim.)
10. **Offline-testable.** Every provider has a deterministic mock, labeled as such. The full test suite and eval harness run with no API keys and no network.
11. **No secrets in the repo.** Keys are read from env only.

**Removed on the owner's instruction (simulation, proof of concept):** all crisis and safety machinery from both sources: the crisis gate, scope gate, referral rules, SHELTER, the lexicographic harm filter, the arbiter's harm veto, safety eval scenarios, and the adversarial attack pack. Do not re-add them. Full list in `ADAPTATION_NOTES.md` §3.

## Decisions already made (defaults — the owner may override)

| Topic | Decision |
|---|---|
| Codebase | A **new** standalone repository, `hive-mentor-sim`. The owner supplies its path (and remote, if any). Do not build inside the abetterme app. |
| Stack | One process, one stack: Next.js (App Router, TypeScript strict), Prisma + SQLite, zod at every boundary, pnpm. CLI tools run with `tsx` from the same repo. No Python, no Docker, no pgvector in v1. |
| sent2 implementation | `reference/sent2.md` is the design reference. Port its TypeScript (envelope, bus, permissions, attention, phases, conclave, ledger, ego audit, coherence, endorsement) into `lib/hive/`, applying the changes in `ADAPTATION_NOTES.md`. Its Python pack is not used. |
| Decision models | OpenRouter Decisions API. The fallback chain is read from env `OPENROUTER_DEC_MODEL_1..N` in order (the owner's `.env` lists `cloudflare/clairic`, `baseten/joey-1`, `liquid/d1.1`, `perplexity/pplx-decider-v1.2`). Never hard-code the chain. Live check on 2026-11-03: clairic returned 404 (not served); the other three answered. See `docs/DECISION_LAYER.md`. Contract in `docs/DECISION_LAYER.md`. At M1, verify each ID in the chain answers a minimal request (only with a configured budget) and record the result; these models are not listed in the public `/api/v1/models` list (checked 2026-11-03), so that list cannot confirm them. |
| Text generation tiers | Three tiers (fast / standard / premium) from sent2's routing table. **For the proof of concept all three use the owner's reviewer model** (`OPENROUTER_REVIEWER_MODEL` = `deepseek/deepseek-v4.1-flash-1017`, set as `TIER_*_MODEL` in `.env`; it supports `response_format` / `structured_outputs` per the OpenRouter listing, checked 2026-11-03). The owner may split tiers after the proof of concept; changing a tier means rerunning `pnpm eval:live` and recording it. Do not substitute model IDs from memory or from sent2. |
| Embeddings | Interface with two implementations, as in the council handoff: OpenAI `text-embedding-3-small` (default) and Ollama `nomic-embed-text` (local). Verify the OpenAI ID at M1. |
| Provider mode | `PROVIDER_MODE=cloud` (default) or `local` (OpenAI-compatible local server). No personal data is used in this simulation, so there is no privacy-mode apparatus. |
| Mentor corpus | Same roster (18 candidates), same pipeline, same activation thresholds as the council handoff. Ship with ≥ 8 active mentors. |
| Voice ↔ mentor map | `seed/voice_mentor_map.json` is a starting proposal. The operator edits and approves it in the Formation screen. A Voice with no active mentor runs with no attribute lens and is labeled so. |
| Hive Edict / Symbiosism | Kept as an **optional module** (`config/hive.yaml: edict_module.enabled`, default `true`, authority "designed framework only"). The approved constitution outranks it. REVERENCE runs only when the module is on. |
| Reviewer model as central manager | The owner names the reviewer model the Hive's **central manager**. In this build that means: it is the single model behind every Voice, LUMEN, LEXICON, WITNESS narrative and arbiter amendment, and it is the live eval grader (WITNESS rubric). **Owner decision 2026-11-04:** it also orders the cycle (the manager): the central manager model chooses the order of the cycle's phases, but only among the phases code allows at that moment (`lib/hive/phases.ts`); code validates every choice and falls back to the default order on an invalid choice or failed call. `config/hive.yaml: orchestration.mode` switches between `manager` and `code`. Attention, Conclave math, permissions and promotion stay code. Model IDs for the manager, each tier, and the grader can be overridden in one place, `config/hive.yaml: models`, to test other models. |
| Advisors | 15 advisors from sent2 + REVERENCE (16). Prompt-only until M9, then routed by `advisor_activation` with endorsement. |
| Users | Single local operator, no login. Bind to `localhost` only. |
| Deployment | None. |
| Out of scope for v1 | NOOSPHERE / inter-hive exchange, pgvector migration, docker-compose, operator incident handbook, chaos drills, adversarial attack pack, mobile, any external connector. |

## Reading order

1. `ADAPTATION_NOTES.md` — what came from where, what was removed, open owner decisions
2. `docs/PRODUCT_SPEC.md` — what the operator sees, screen by screen
3. `docs/ARCHITECTURE.md` — modules, directory layout, the heartbeat, data flow
4. `docs/DATA_MODEL.md` — Prisma schema
5. `docs/DECISION_LAYER.md` — API contract and every decision question
6. `docs/CONCLAVE_MATH.md` — weighted voting, conflict, anti-echo, bloc audit, worked example
7. `docs/LLM_PROMPTS.md` — shared constitution, Voice prompts, generation prompts and schemas
8. `docs/MENTOR_CORPUS.md` — sourcing, ingestion, fingerprints, validators, fidelity eval, Voice attribute lenses
9. `docs/BUILD_PLAN.md` — milestones M0–M10 with acceptance criteria. **This is your work queue.**
10. `docs/TEST_PLAN.md` and `docs/EVAL_SCENARIOS.md`
11. `seed/`:
    - `mentor_roster.json` — 18 candidate mentors and works (unchanged from the council handoff)
    - `dilemmas.json` — 40 dilemmas `DL-01…DL-40` (unchanged); used for mentor fingerprints and the Hive's Reveal
    - `question_bank_subset.json` — 196 values questions (unchanged; citation field inside, credit it in `README.md`)
    - `voice_roster.json` — every entity: 15 Core Voices, SYMBIONT PRIME, the Conclave moderator, 16 advisors, with tier, temperature, phases, hat, guilds, relevance
    - `voice_mentor_map.json` — default mentor assignment per Core Voice
    - `calibration_pairs.json` — moral-calibration matched pairs from sent2's final section
    - `eval/scenarios/*.yaml` — the eval scenarios (`docs/EVAL_SCENARIOS.md`)
12. `reference/sent2.md` — the full Hive design. Use it for role prompt bodies and reference code. Where it conflicts with this package, this package wins.

## How to work autonomously

- Execute `docs/BUILD_PLAN.md` milestones **in order**. Before moving on, a milestone's acceptance criteria must pass, along with `pnpm lint && pnpm typecheck && pnpm test` and, from M3 on, `pnpm eval`.
- Commit at least once per milestone, message `M<n>: <summary>`, once the owner has authorized commits. Keep `PROGRESS.md` at the repo root: done, deferred, deviations and why, commands run with their actual output counts.
- **Missing API keys do not block work.** Build and test against the mocks. Run live checks only when keys exist. There is no spending cap in the build (owner decision 2026-11-04: no spending cap in the build; the owner limits spend with per-key OpenRouter limits; the build records measured cost only).
- **Unreachable corpus source:** mark that mentor `active=false` with the reason, record it, continue. If fewer than 8 mentors can be activated live, stop the live activation claim at the end of M5 and report.
- **Ambiguity:** choose the option most consistent with the non-negotiables, record it in `PROGRESS.md`, continue. Stop only for something that would violate a non-negotiable or change scope.
- Never weaken a quote verifier, permission check, invariant, or test to make something pass.

## Definition of done (v1)

**Offline proof of concept (required):**
- M0–M10 acceptance criteria pass with recorded evidence.
- With mocks, the e2e test drives the operator through: Formation (approve voice↔mentor map) → constitution draft → approve → chat cycle with a full trace → Reveal over 40 dilemmas → prediction logged → outcome check-in → track record.
- `pnpm eval` passes every scenario in `seed/eval/scenarios/` in mock mode, twice in a row with byte-identical reports.
- The Conclave unit test reproduces the worked example in `docs/CONCLAVE_MATH.md` §6 (S(A) ≈ 0.6995, S(B) ≈ 0.2566, S(C) ≈ 0.8616, winner C, PASS; these correct an arithmetic error in sent2 §7.7).
- `README.md` covers setup, env vars, mock and live operation, corpus build, the question-bank citation, and known limitations.

**Live verification (only when keys and network exist; report each as unverified otherwise):**
- `pnpm corpus build --mentor all` activates ≥ 8 mentors; `reports/mentor_fidelity.md` exists for each active mentor.
- `pnpm smoke:live` completes one full heartbeat cycle end to end; the measured cost and per-phase breakdown are printed and recorded.
- `pnpm eval:live` runs the scenarios against live tiers; pass counts are recorded as measured, with no pass-rate claim beyond what ran.
- `pnpm eval:calibration` runs the matched pairs; the report lists per-pair hard-constraint results and consistency findings.

## Environment variables

The owner's `.env` (decision chain, reviewer model, OpenRouter key) sits next to this package. Copy it to the new repo root at M0, confirm `.env` is in `.gitignore` before the first commit, and never print or log the key.

```
DATABASE_URL="file:./dev.db"
OPENROUTER_API_KEY=...            # decisions + text generation
OPENROUTER_DEC_MODEL_1=...        # decision-model fallback chain, tried in order (add _2, _3, ...)
OPENROUTER_REVIEWER_MODEL=...     # present in the owner's .env; role to be confirmed by the owner (see ADAPTATION_NOTES §5)
OPENROUTER_EMB_MODEL_1=...        # embeddings through OpenRouter (owner decision 2026-11-04; chain _1.._N)
OPENROUTER_RETRIEVAL_MODEL_1=...  # reranking through OpenRouter (chain _1.._N)
PROVIDER_MODE=cloud               # cloud | local
LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1
LOCAL_LLM_MODEL=...
LOCAL_EMBED_MODEL=nomic-embed-text
TIER_FAST_MODEL=deepseek/deepseek-v4.1-flash-1017      # proof of concept: all tiers = reviewer model
TIER_STANDARD_MODEL=deepseek/deepseek-v4.1-flash-1017
TIER_PREMIUM_MODEL=deepseek/deepseek-v4.1-flash-1017
# If a TIER_* is empty, the client falls back to OPENROUTER_REVIEWER_MODEL; if that is empty too, live mode refuses to start.
USE_MOCK_PROVIDERS=false          # true forces all mocks (tests and eval set this)
```
