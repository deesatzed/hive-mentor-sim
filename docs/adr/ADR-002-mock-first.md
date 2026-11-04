# ADR-002: Mock-first; no key needed until live checks

**Status:** accepted (M0, 2026-11-03)

**Context.** Live model calls cost money and change over time. The owner's original handoff approved mock providers for offline tests.

**Decision.** `lib/council/providers/mocks.ts` provides `MockDecider`, `MockLLM`, and `MockEmbedder`. They are used only when `USE_MOCK_PROVIDERS=true`, which unit tests, e2e, and `pnpm eval` set. Every mock result is labeled (`model: "mock:*"`, `calibrated: false`), and mock-derived numbers in reports carry the label "mock". Live behavior is verified separately (`pnpm smoke:live`, `pnpm eval:live`) and reported as measured.

**Consequences.** `pnpm lint && pnpm typecheck && pnpm test && pnpm eval && pnpm test:e2e` runs with no API keys. Mock results never stand in for live results in any report.
