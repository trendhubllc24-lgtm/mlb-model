import { Redis } from "@upstash/redis";
import { getGamePitchers } from "@/lib/sources";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();
const BATCH = 25; // box score fetches are heavier than the day-schedule ones — kept conservative

// Resumable, walks through every already-graded game and pulls its
// starting pitchers (IP, ER, and — since v2 — strikeouts/walks/hits plus
// the team's combined bullpen line) from ESPN's box score — one extra API
// call per game, batched and parallelized. This is a MUCH longer process
// than the season backfill (one call per game instead of one call per ~13
// games), so expect to run this command many, many times. Safe to call
// repeatedly — games already at v2 (or confirmed unavailable) are skipped;
// games fetched under the old v1 extractor (starter IP/ER only) get
// re-fetched once to pick up the bullpen + K data.
const SCHEMA_V = 2;

export async function GET(req) {
  const authed = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!authed) return new Response("unauthorized", { status: 401 });

  try {
    const predictions = (await redis.get("mlb-predictions")) || {};
    const pitcherStarts = (await redis.get("mlb-pitcher-starts")) || {};

    const resolvedIds = Object.entries(predictions).filter(([, p]) => p.resolved);
    const needsFetch = ([gid]) => {
      const e = pitcherStarts[gid];
      return !e || (!e.unavailable && e.v !== SCHEMA_V);
    };
    const missing = resolvedIds
      .filter(needsFetch)
      .sort((a, b) => new Date(a[1].date) - new Date(b[1].date))
      .slice(0, BATCH);

    if (missing.length === 0) {
      return Response.json({ ok: true, done: true, totalGraded: resolvedIds.length, message: "All graded games already have v2 pitcher+bullpen data (or were confirmed unavailable)." });
    }

    const results = await Promise.all(missing.map(([gid]) => getGamePitchers(gid)));
    let filled = 0;
    missing.forEach(([gid, p], i) => {
      if (results[i]) { pitcherStarts[gid] = { v: SCHEMA_V, date: p.date, ...results[i] }; filled++; }
      else if (!pitcherStarts[gid]) pitcherStarts[gid] = { date: p.date, unavailable: true }; // don't retry forever on a bad game
      else pitcherStarts[gid].v = SCHEMA_V; // v1 data exists but re-fetch failed — keep it, stop retrying
    });

    await redis.set("mlb-pitcher-starts", pitcherStarts);

    const remaining = resolvedIds.filter(needsFetch).length;
    return Response.json({
      ok: true, done: remaining <= 0,
      processedThisBatch: missing.length, filled,
      totalGraded: resolvedIds.length, remaining,
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
