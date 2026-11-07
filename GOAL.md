# Goal: Build The Mentor Hive (simulation proof of concept)

```text
/goal
OUTCOME:
Build a working local, single-operator proof of concept of The Mentor Hive in a new repository, hive-mentor-sim, according to HANDOFF.md and docs/BUILD_PLAN.md milestones M0–M10. A swarm of 15 LLM Voices runs the phased heartbeat from reference/sent2.md and speaks as one simulated sentient AI whose human attributes come only from verified writings of historical mentors. The operator can compose the Hive (voice↔mentor formation), approve its constitution, talk to it and inspect every phase of each cycle, run the Reveal and calibration suites, and log outcomes of the Hive's predictions.

PROOF OF DONE:
1. Confirm the target path (and remote, if any) with the owner; record absolute path, branch, HEAD in PROGRESS.md. This handoff directory is a package, not the app.
2. Text tiers: for the proof of concept all three (fast / standard / premium) use the owner's reviewer model from .env (deepseek/deepseek-v4.1-flash-1017), which is also the live eval grader. Decision models come from the .env chain. Do not use model IDs from memory.
3. Complete M0–M10 acceptance criteria, recording commands, actual counts, deviations, and deferred live checks in PROGRESS.md.
4. With mock providers and no API keys: pnpm lint, typecheck, test, eval (twice, byte-identical reports), test:e2e, and build all pass; the e2e journey runs formation → constitution → chat cycle with full trace → Reveal over 40 dilemmas → prediction → check-in → track record.
5. Tests demonstrate: cite-or-silence (fabricated and out-of-lens quotes never survive); no mentor first person; bus permission violations throw; advisors never vote; WITNESS audits post-integration; the corrected Conclave worked example (S(C) ≈ 0.8616); ego-capture fixture produces a CONFLICT marker and REFLECT; calibration cycles promote nothing; removed crisis/safety items stay removed.
6. When keys and network exist: run the live corpus build (≥ 8 active mentors), pnpm smoke:live, pnpm eval:live, and pnpm eval:calibration; record measured results and costs. Report any unrun live check as unverified.
7. README.md covers setup, env vars, mock vs live, model configuration (.env tiers and decision chain), corpus build, Reveal and calibration, known limitations, and the question-bank citation.

SCOPE:
- Read HANDOFF.md, ADAPTATION_NOTES.md, docs/*.md, seed/, then reference/sent2.md sections as referenced.
- Single Next.js + Prisma/SQLite + zod app, pnpm. Port sent2's TypeScript modules into lib/hive/ with the changes in ADAPTATION_NOTES.md. Port the council handoff's provider, ledger, quote, retrieval, corpus, metrics, signals, and track-record methods into lib/council/.
- Excluded: crisis and safety machinery of any kind (owner decision), NOOSPHERE, pgvector, docker, attack packs, deployment, login, external connectors, living or recent mentors, mentor first-person voice.

CONSTRAINTS:
- Proof of concept. Mentors are attribute sources, never personas. The US public-domain rule holds; there is no date-of-death cutoff (owner decision 2026-11-07). Verified text matches are not proof that an interpretation is correct; say so where shown.
- Decision models judge; LLMs write. Attention, Conclave math, permissions, and promotion are deterministic code. Phase order: the central manager model chooses among the phases code allows (owner decision 2026-11-04; `orchestration.mode` in config/hive.yaml switches it to code order).
- Do not weaken quote verification, permissions, invariants, or tests to pass checks. Where a source or model is unavailable, keep explicit no-evidence or unavailable states.
- Label every mock-derived number as mock. Report measured numbers only; no cost or time estimates.
- No spending cap in the build (owner decision 2026-11-04: no spending cap in the build; the owner limits spend with per-key OpenRouter limits; the build records measured cost only).

ITERATION:
- Inspect first, keep a concise milestone queue in PROGRESS.md, work M0–M10 in order in small batches, run focused checks after each batch. Diagnose failures rather than weakening criteria. If the same failure survives two fix attempts, stop, list causes, add logging, then fix, and record it in ERROR_LOG.md.
- Commit per milestone only once the owner authorizes commits.

STOP:
- Before destructive actions, deployment, access outside authorized paths, or a material scope change.
- For input only the owner can give: target path; any change to model choices.

COMPLETE:
- Offline proof of concept complete only when item 4 and 5 pass with evidence and docs are current.
- Live verification complete only when item 6 passes with recorded evidence; otherwise list each missing check plainly.
```
