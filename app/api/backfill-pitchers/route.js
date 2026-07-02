import { Redis } from "@upstash/redis";
import { getGamePitchers } from "@/lib/sources";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();
const BATCH = 25; // box score fetches are heavier than the day-schedule ones — kept conservative

// Resumable, walks through every already-graded game and pulls its
// starting pitchers (IP, ER) from ESPN's box score — one extra API call
// per game, batched and parallelized. This is a MUCH longer process than
// the season backfill (one call per game instead of one call per ~13
// games), so expect to run this command many, many times. Safe to call
// repeatedly — games already fetched (or confirmed unavailable) are
// skipped automatically.
export async function GET(req) {
  const authed = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!authed) return new Response("unauthorized", { status: 401 });

  try {
    const predictions = (await redis.get("mlb-predictions")) || {};
    const pitcherStarts = (await redis.get("mlb-pitcher-starts")) || {};

    const resolvedIds = Object.entries(predictions).filter(([, p]) => p.resolved);
    const missing = resolvedIds
      .filter(([gid]) => !pitcherStarts[gid])
      .sort((a, b) => new Date(a[1].date) - new Date(b[1].date))
      .slice(0, BATCH);

    if (missing.length === 0) {
      return Response.json({ ok: true, done: true, totalGraded: resolvedIds.length, message: "All graded games already have pitcher data (or were confirmed unavailable)." });
    }

    const results = await Promise.all(missing.map(([gid]) => getGamePitchers(gid)));
    let filled = 0;
    missing.forEach(([gid, p], i) => {
      if (results[i]) { pitcherStarts[gid] = { date: p.date, ...results[i] }; filled++; }
      else pitcherStarts[gid] = { date: p.date, unavailable: true }; // don't retry forever on a bad game
    });

    await redis.set("mlb-pitcher-starts", pitcherStarts);

    const remaining = resolvedIds.length - Object.keys(pitcherStarts).length;
    return Response.json({
      ok: true, done: remaining <= 0,
      processedThisBatch: missing.length, filled,
      totalGraded: resolvedIds.length, remaining: Math.max(0, remaining),
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
