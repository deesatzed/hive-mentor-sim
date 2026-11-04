import type { FetchLike } from "@/lib/council/providers/http";
import type { Ledger, LedgerInput } from "@/lib/council/ledger";

/** A scripted fetch for provider tests: each call takes the next response; requests are recorded. */
export type Scripted = { status: number; body: unknown } | { throws: Error };

export function fakeFetch(script: Scripted[]) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    const next = script.shift();
    if (!next) throw new Error("fakeFetch: no scripted response left");
    if ("throws" in next) throw next.throws;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status });
  };
  return { impl, calls };
}

export const noSleep = async () => {};

/** Records ledger events in memory, for asserting what a provider would write. */
export class MemoryLedger implements Ledger {
  events: LedgerInput[] = [];
  async record(ev: LedgerInput) {
    this.events.push(ev);
    return { id: `ev_${this.events.length}` };
  }
}
