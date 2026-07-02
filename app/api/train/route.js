import { Redis } from "@upstash/redis";
import { trainGBoost, MIN_TRAINING_ROWS } from "@/lib/gboost";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();

// Trains the Gradient Boosted Trees model on whatever's currently in
// mlb-predictions (backfilled history + live-tracked games) and stores it.
// Call this after backfilling, and occasionally afterward (e.g. once a
// day) as more games get graded, so it keeps learning too.
export async function GET(req) {
  const authed = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!authed) return new Response("unauthorized", { status: 401 });

  try {
    const predictions = (await redis.get("mlb-predictions")) || {};
    const rows = Object.values(predictions).filter(
      (p) => p.resolved && typeof p.ratingDiff === "number" && typeof p.homeAdvUsed === "number"
    );

    let meta;
    if (rows.length < MIN_TRAINING_ROWS) {
      meta = { trainedOn: rows.length, trainAccuracy: null, ready: false, trainedAt: new Date().toISOString() };
    } else {
      const X = rows.map((p) => [p.ratingDiff, p.homeAdvUsed]);
      const y = rows.map((p) => (p.actual === "A" ? 1 : 0)); // 1 = home team won
      const { model, trainAccuracy } = trainGBoost(X, y);
      await redis.set("mlb-forest-model", model);
      meta = { trainedOn: rows.length, trainAccuracy, ready: true, trainedAt: new Date().toISOString() };
    }

    await redis.set("mlb-forest-meta", meta);
    const existing = (await redis.get("mlb-snapshot")) || {};
    await redis.set("mlb-snapshot", { ...existing, forestMeta: meta });

    return Response.json({ ok: true, ...meta });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
