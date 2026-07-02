import { Redis } from "@upstash/redis";
import { trainGBoost, MIN_TRAINING_ROWS } from "@/lib/gboost";
import { buildFeatureContext, featuresFor, FEATURE_NAMES } from "@/lib/features";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();

// Trains the Gradient Boosted Trees model on whatever's currently in
// mlb-predictions (backfilled history + live-tracked games) and stores it.
// The feature vector (see lib/features.js FEATURE_NAMES) now covers team
// strength, home edge, scoring form, starter ERA + K-rate, rest days,
// bullpen ERA, park factor, and game-day weather — all computed fresh from
// history using only information available before the game being
// predicted, so there's no leakage of future results into training.
// Any input that hasn't been backfilled yet (pitchers via
// /api/backfill-pitchers, weather via /api/backfill-weather) degrades to a
// neutral value for that game rather than breaking training.
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
      meta = { trainedOn: rows.length, trainAccuracy: null, ready: false, features: FEATURE_NAMES.length, trainedAt: new Date().toISOString() };
    } else {
      const ctx = await buildFeatureContext(redis, predictions);
      const X = rows.map(([gid, p]) => featuresFor(ctx, {
        gid, home: p.a, away: p.b, date: p.date,
        ratingDiff: p.ratingDiff, homeAdvUsed: p.homeAdvUsed,
      }));
      const y = rows.map(([, p]) => (p.actual === "A" ? 1 : 0)); // 1 = home team won
      const { model, trainAccuracy, featureImportance } = trainGBoost(X, y);
      await redis.set("mlb-forest-model", model);
      // Each feature's share of total SSE-reduction across every split in
      // every tree — how much the model is actually LEANING on it, not
      // just whether it's present. Read alongside the backtest's held-out
      // accuracy: a feature with high importance here but no accuracy lift
      // there is a real candidate for overfitting/noise, not signal.
      const importanceByFeature = Object.fromEntries(
        FEATURE_NAMES.map((n, i) => [n, Math.round(featureImportance[i] * 1000) / 1000])
      );
      meta = { trainedOn: rows.length, trainAccuracy, ready: true, features: FEATURE_NAMES.length, featureNames: FEATURE_NAMES, importanceByFeature, trainedAt: new Date().toISOString() };
    }

    await redis.set("mlb-forest-meta", meta);
    const existing = (await redis.get("mlb-snapshot")) || {};
    await redis.set("mlb-snapshot", { ...existing, forestMeta: meta });

    return Response.json({ ok: true, ...meta });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
