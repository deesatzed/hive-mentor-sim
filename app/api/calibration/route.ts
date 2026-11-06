import type { NextRequest } from "next/server";
import { getDb } from "@/lib/council/db";
import { calibrationResults } from "@/lib/hive/calibration";
import { calibrationStatus, startCalibration } from "@/lib/hive/calibrationServer";

export async function GET() {
  try {
    return Response.json({ ...(await calibrationResults(getDb())), run: calibrationStatus() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Runs variants in the background: body {ids?: string[]} (omit for all). 202 started, 409 already running. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string" && /^CAL-[\w-]+$/.test(x)) : undefined;
  const r = startCalibration(ids);
  return Response.json({ ...r, run: calibrationStatus() }, { status: r.started ? 202 : 409 });
}
