import { Redis } from "@upstash/redis";
import { PARK_TEAMS } from "@/lib/parks";
import { fetchWeatherHistory, fetchWeatherForecast, weatherKeyFor } from "@/lib/weather";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();
const BATCH = 5; // parks per call — each park is 1-2 archive calls covering all of 2020-today
const HISTORY_START = "2020-03-01"; // just before the earliest (COVID-delayed) season in the dataset

// Resumable backfill of game-day weather (daily high °C + max wind km/h)
// for every park, 2020 -> today, from Open-Meteo (free, no key). Call
// repeatedly until "done": true — it walks the 30 teams in batches of 5,
// so ~6 calls covers the league. Re-running refreshes a park's whole
// history (cheap: still one archive call), so it's also the way to heal
// any gaps. /api/refresh keeps the NEXT week's forecast fresh on its own;
// this route is for the historical training window.
export async function GET(req) {
  const authed = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!authed) return new Response("unauthorized", { status: 401 });

  const url = new URL(req.url);
  const reset = url.searchParams.get("reset") === "1";
  const cursorKey = "mlb-weather-cursor";
  // Same Upstash gotcha as the season backfill: numbers round-trip as
  // numbers, so parse defensively.
  let cursor = reset ? 0 : Number((await redis.get(cursorKey)) || 0);
  if (!Number.isFinite(cursor) || cursor < 0 || cursor >= PARK_TEAMS.length) cursor = 0;

  try {
    const batch = PARK_TEAMS.slice(cursor, cursor + BATCH);
    const results = await Promise.all(batch.map(async (team) => {
      try {
        const [history, forecast] = await Promise.all([
          fetchWeatherHistory(team, HISTORY_START),
          fetchWeatherForecast(team), // covers the ~6-day archive lag + next week
        ]);
        const map = { ...history, ...forecast };
        if (Object.keys(map).length === 0) return { team, ok: false, days: 0 };
        await redis.set(weatherKeyFor(team), map);
        return { team, ok: true, days: Object.keys(map).length };
      } catch (err) {
        return { team, ok: false, error: String(err) };
      }
    }));

    const next = cursor + batch.length;
    const done = next >= PARK_TEAMS.length;
    await redis.set(cursorKey, done ? 0 : next);

    return Response.json({
      ok: true, done,
      parksProcessed: results,
      progress: `${next}/${PARK_TEAMS.length} parks`,
      nextCursor: done ? null : next,
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
