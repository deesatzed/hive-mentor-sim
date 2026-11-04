# ADR-003: Invariants as tests or eval scenarios before the feature

**Status:** accepted (M0, 2026-11-03; from sent2 ADR-003)

**Decision.** Each invariant in `HANDOFF.md` and `docs/EVAL_SCENARIOS.md` is written as a unit test or eval scenario before the code it constrains. A verifier, permission check, invariant, or test is never weakened to make something pass.

**Consequences.** Milestones start with failing tests. Scenario YAML in `seed/eval/scenarios/` is the acceptance contract for behavior.
