import { Suspense } from "react";
import { CycleView } from "./cycle-view";

/** /cycles/[id] — the route param is read inside Suspense (cacheComponents prerendering). */
export default function CyclePage({ params }: PageProps<"/cycles/[id]">) {
  return (
    <Suspense fallback={<main className="home"><p className="muted">Loading…</p></main>}>
      <CycleView params={params} />
    </Suspense>
  );
}
