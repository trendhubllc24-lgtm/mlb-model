import { Redis } from "@upstash/redis";
import { getEspnSlate, extractLiveGames, updateTrackRecord } from "@/lib/sources";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();

// Cheap, frequent sibling to /api/refresh — only re-checks ESPN and grades
// any game that finished since the last check, so the Live Prediction
// Tracker updates soon after a final out instead of waiting for the next
// full refresh (which also pulls Polymarket/Kalshi/standings).
export async function GET(req) {
  const authed = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!authed) return new Response("unauthorized", { status: 401 });

  try {
    const slate = await getEspnSlate();
    const existing = (await redis.get("mlb-snapshot")) || {};
    // Reuse whatever home-field map the last full refresh computed, rather
    // than re-pulling standings every couple minutes just for this.
    const track = await updateTrackRecord(redis, slate, existing.homeAdv);
    const live = extractLiveGames(slate);

    const snapshot = { ...existing, track, live, ratings: track.ratings, trackUpdatedAt: new Date().toISOString() };
    await redis.set("mlb-snapshot", snapshot);

    return Response.json({ ok: true, trackTotal: track.total, updatedAt: snapshot.trackUpdatedAt });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
