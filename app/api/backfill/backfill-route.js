import { Redis } from "@upstash/redis";
import { getDaySlate, updateTrackRecord } from "@/lib/sources";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();
const BATCH_DAYS = 10; // how many calendar days to process per call — keeps each request well inside serverless time limits

function fmtDate(d) { return d.toISOString().slice(0, 10).replace(/-/g, ""); }
function addDays(yyyymmdd, n) {
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6) - 1, d = +yyyymmdd.slice(6, 8);
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return fmtDate(dt);
}

// Real MLB regular-season start dates — spring training is excluded on
// purpose (exhibition results don't reflect real team strength).
// Real MLB Opening Day / season-end dates, verified — 2020 was the
// COVID-shortened 60-game season (started late July); 2022 opened late due
// to the lockout. A few days of buffer added on each end since checking an
// extra empty day costs nothing (it just contributes zero games).
const SEASON_START = {
  "2020": "20200723", "2021": "20210401", "2022": "20220407",
  "2023": "20230330", "2024": "20240328", "2025": "20250327", "2026": "20260326",
};
const SEASON_END = {
  "2020": "20200930", "2021": "20211007", "2022": "20221009",
  "2023": "20231005", "2024": "20241003", "2025": "20251002", "2026": "20261231",
}; // 2026 end will be reached naturally once "today" catches up

// Resumable, one-year-at-a-time backfill: predicts + immediately grades
// every real (regular-season, finished) game in chronological day order,
// which is also how team ratings evolve through the Elo update in
// updateTrackRecord — so by the end, ratings reflect the whole season's
// results, not just games seen since deployment.
//
// Call repeatedly (e.g. curl in a loop, or just hit it a bunch of times)
// until the response says "done": true for that year. Safe to call more
// than once — already-graded games are skipped automatically.
export async function GET(req) {
  const authed = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!authed) return new Response("unauthorized", { status: 401 });

  const url = new URL(req.url);
  const year = url.searchParams.get("year") || "2025";
  const reset = url.searchParams.get("reset") === "1";
  const seasonStart = SEASON_START[year] || `${year}0301`;
  const seasonEnd = SEASON_END[year] || `${year}1130`;
  const today = fmtDate(new Date());

  const cursorKey = `mlb-backfill-cursor-${year}`;
  let cursor = reset ? seasonStart : ((await redis.get(cursorKey)) || seasonStart);

  const days = [];
  for (let i = 0; i < BATCH_DAYS; i++) {
    const d = addDays(cursor, i);
    if (d > seasonEnd || d > today) break;
    days.push(d);
  }

  if (days.length === 0) {
    return Response.json({ ok: true, done: true, year, message: `Backfill for ${year} is already complete.` });
  }

  try {
    const dayResults = await Promise.all(days.map(getDaySlate));
    // Only real, finished, regular-season games count for training.
    const games = dayResults.flat().filter((g) => g.state === "post" && g.seasonType === 2);

    const existing = (await redis.get("mlb-snapshot")) || {};
    const track = await updateTrackRecord(redis, games, existing.homeAdv);

    const nextCursor = addDays(days[days.length - 1], 1);
    const done = nextCursor > seasonEnd || nextCursor > today;
    await redis.set(cursorKey, done ? seasonStart : nextCursor);

    return Response.json({
      ok: true, done, year,
      daysProcessed: days,
      gamesGradedThisBatch: games.length,
      trackTotal: track.total,
      accuracy: track.accuracy,
      nextCursor: done ? null : nextCursor,
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err), lastCursorTried: cursor }, { status: 200 });
  }
}
