import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/council/db";
import { ConstitutionError, editPrinciple, retirePrinciple } from "@/lib/hive/constitution";
import { serverProviders } from "@/lib/hive/serverProviders";

const Body = z.object({ text: z.string().max(400).optional(), axis: z.string().max(60).optional(), action: z.enum(["retire"]).optional() });

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/constitution/principles/[id]">) {
  const { id } = await ctx.params;
  const b = Body.safeParse(await req.json().catch(() => null));
  if (!b.success) return Response.json({ error: "invalid body" }, { status: 400 });
  try {
    if (b.data.action === "retire") {
      await retirePrinciple(getDb(), serverProviders().ledger, id);
      return Response.json({ ok: true });
    }
    return Response.json(await editPrinciple(getDb(), id, { text: b.data.text, axis: b.data.axis }));
  } catch (e) {
    if (e instanceof ConstitutionError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
