import { getDb } from "@/lib/council/db";
import { serverHive } from "@/lib/hive/server";

export async function GET() {
  const sessions = await getDb().hiveSession.findMany({ orderBy: { createdAt: "desc" }, take: 50, select: { id: true, mode: true, title: true, createdAt: true } });
  return Response.json({ sessions });
}

export async function POST() {
  const id = await serverHive().createSession("chat", "web");
  return Response.json({ id });
}
