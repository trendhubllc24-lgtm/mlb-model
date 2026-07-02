import { Redis } from "@upstash/redis";
import { trainForest } from "@/lib/forest";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();

// Trains the Random Forest on whatever's currently in mlb-predictions
// (backfilled history + live-tracked games) and stores the trained model.
// Call this after backfilling, and occasionally afterward (e.g. once a
// day) as more games get graded, so the forest keeps learning too.
export async function GET(req) {
  const authed = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!authed) return new Response("unauthorized", { status: 401 });

  try {
    const predictions = (await redis.get("mlb-predictions")) || {};
    const result = trainForest(predictions);

    if (result.ready) {
      await redis.set("mlb-forest-model", result.modelJSON);
    }
    const meta = { trainedOn: result.trainedOn, trainAccuracy: result.trainAccuracy, ready: result.ready, trainedAt: new Date().toISOString() };
    await redis.set("mlb-forest-meta", meta);

    // fold meta into the live snapshot too, so the UI can show it without an extra fetch
    const existing = (await redis.get("mlb-snapshot")) || {};
    await redis.set("mlb-snapshot", { ...existing, forestMeta: meta });

    return Response.json({ ok: true, ...meta });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
