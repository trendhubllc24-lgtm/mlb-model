import { Redis } from "@upstash/redis";
import { trainGBoost, MIN_TRAINING_ROWS } from "@/lib/gboost";
import { buildTeamGameLogs, recentForm } from "@/lib/form";
import { buildPitcherLogs, pitcherEraAsOf } from "@/lib/pitcherForm";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();

// Trains the Gradient Boosted Trees model on whatever's currently in
// mlb-predictions (backfilled history + live-tracked games) and stores it.
// 4 features: ratingDiff, homeAdvUsed, formDiff (recent scoring form), and
// pitcherDiff (starting pitcher rolling ERA gap) — all computed fresh from
// history using only information available before the game being
// predicted, so there's no leakage of future results into training.
// pitcherDiff falls back to 0 (neutral) for any game that hasn't had its
// starters backfilled yet via /api/backfill-pitchers.
// Call this after backfilling, and occasionally afterward (e.g. once a
// day) as more games get graded, so it keeps learning too.
export async function GET(req) {
  const authed = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!authed) return new Response("unauthorized", { status: 401 });

  try {
    const predictions = (await redis.get("mlb-predictions")) || {};
    const rows = Object.entries(predictions).filter(
      ([, p]) => p.resolved && typeof p.ratingDiff === "number" && typeof p.homeAdvUsed === "number"
    );

    let meta;
    if (rows.length < MIN_TRAINING_ROWS) {
      meta = { trainedOn: rows.length, trainAccuracy: null, ready: false, features: 4, trainedAt: new Date().toISOString() };
    } else {
      const teamLogs = buildTeamGameLogs(predictions);
      const pitcherStarts = (await redis.get("mlb-pitcher-starts")) || {};
      const pitcherLogs = buildPitcherLogs(pitcherStarts);

      const X = rows.map(([gid, p]) => {
        const formDiff = recentForm(teamLogs[p.a], p.date) - recentForm(teamLogs[p.b], p.date);
        const starters = pitcherStarts[gid];
        const pitcherDiff = (starters && !starters.unavailable)
          ? pitcherEraAsOf(pitcherLogs, starters.away.name, p.date) - pitcherEraAsOf(pitcherLogs, starters.home.name, p.date)
          : 0;
        return [p.ratingDiff, p.homeAdvUsed, formDiff, pitcherDiff];
      });
      const y = rows.map(([, p]) => (p.actual === "A" ? 1 : 0)); // 1 = home team won
      const { model, trainAccuracy } = trainGBoost(X, y);
      await redis.set("mlb-forest-model", model);
      meta = { trainedOn: rows.length, trainAccuracy, ready: true, features: 4, trainedAt: new Date().toISOString() };
    }

    await redis.set("mlb-forest-meta", meta);
    const existing = (await redis.get("mlb-snapshot")) || {};
    await redis.set("mlb-snapshot", { ...existing, forestMeta: meta });

    return Response.json({ ok: true, ...meta });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
