import { z } from "zod";
import { getDb } from "@/lib/council/db";
import { approveConstitution, ConstitutionError } from "@/lib/hive/constitution";
import { serverProviders } from "@/lib/hive/serverProviders";

/** Operator approval of a draft version (the only way the constitution changes). */
export async function POST(req: Request) {
  const b = z.object({ version: z.number().int().positive(), exclude: z.array(z.string()).optional() }).safeParse(await req.json().catch(() => null));
  if (!b.success) return Response.json({ error: "version is required" }, { status: 400 });
  try {
    return Response.json(await approveConstitution(getDb(), serverProviders().ledger, b.data.version, b.data.exclude ?? []));
  } catch (e) {
    if (e instanceof ConstitutionError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
