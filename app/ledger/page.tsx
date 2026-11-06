import { Suspense } from "react";
import { LedgerView } from "./ledger-view";

/** /ledger[?cycle=<id>] — search params are read inside Suspense (cacheComponents prerendering). */
export default function LedgerPage({ searchParams }: PageProps<"/ledger">) {
  return (
    <Suspense fallback={<main className="home"><p className="muted">Loading…</p></main>}>
      <LedgerView searchParams={searchParams} />
    </Suspense>
  );
}
