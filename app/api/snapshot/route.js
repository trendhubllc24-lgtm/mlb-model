import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();

export async function GET() {
  const snap = await redis.get("mlb-snapshot");
  return Response.json(snap || { updatedAt: null, winner: [], schedule: [] });
}
