"use client";

import { use, useEffect, useState } from "react";
import { ReplyText, TraceView, type Conclave, type Trace } from "@/app/hive/trace-view";

/** /cycles/[id] — one stored cycle with its full trace (Reveal and constitution-mirror rows link here). */

type Data = { cycle: { id: string; cycleNo: number; input: string; output: string | null; status: string; costUsd: number }; trace: Trace; conclave: Conclave | null; error?: string };

export function CycleView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => {
    fetch(`/api/cycles/${id}`)
      .then((x) => x.json())
      .then(setD);
  }, [id]);
  if (!d) return <main className="home"><p className="muted">Loading…</p></main>;
  if (d.error) return <main className="home"><p className="error">{d.error}</p></main>;
  return (
    <main className="home wide">
      <h1>Cycle {d.cycle.cycleNo}</h1>
      <p className="muted">
        Mode: {d.trace.mode} · status {d.cycle.status} · cost ${d.cycle.costUsd.toFixed(6)}
      </p>
      <p className="you">{d.cycle.input}</p>
      <p className="reply" data-testid="cycle-output">
        {d.cycle.status === "done" ? <ReplyText text={d.cycle.output ?? ""} quotes={d.trace.compose.quotes ?? []} /> : `The cycle stopped in ${d.trace.error?.phase}: ${d.trace.error?.message}`}
      </p>
      <TraceView t={d.trace} conclave={d.conclave} />
    </main>
  );
}
