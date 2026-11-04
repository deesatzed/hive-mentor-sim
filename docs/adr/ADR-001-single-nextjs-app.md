# ADR-001: One Next.js app; sent2 is a design reference

**Status:** accepted (M0, 2026-11-03)

**Context.** `reference/sent2.md` describes the Hive as several services (TypeScript runtime, Python eval pack, Docker, pgvector). The council handoff this build follows is a single local app.

**Decision.** Build one process, one stack: Next.js (App Router, TypeScript strict), Prisma + SQLite, zod at every boundary, pnpm. CLI tools (REPL, corpus, eval, smoke) run with `tsx` from the same repo. sent2's TypeScript designs are ported into `lib/hive/` with the changes in `ADAPTATION_NOTES.md`; its Python pack is not used.

**Consequences.** No Docker, no Python, no pgvector in v1. Vector search runs in-process over SQLite rows. Where sent2 and this package disagree, this package wins.
