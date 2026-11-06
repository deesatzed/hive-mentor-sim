import { getDb } from "@/lib/council/db";
import { predictionsView } from "@/lib/hive/predictions";

/** Predictions (due, upcoming, checked in), track record per Voice and per mentor lens, commitments. */
export async function GET() {
  return Response.json(await predictionsView(getDb()));
}
