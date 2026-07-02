import { Redis } from "@upstash/redis";
import { predictGBoost } from "@/lib/gboost";
import { formDiffFor } from "@/lib/form";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();

// Public, read-only: given a home/away team, returns the Gradient Boosted
// Trees model's independent win-probability read for that matchup, using
// the same 3 features it was trained on: ratingDiff, homeAdv, and each
// team's recent scoring form (as of right now). No secret needed — this
// never writes anything.
export async function GET(req) {
  try {
    const url = new URL(req.url);
    const home = url.searchParams.get("home");
    const away = url.searchParams.get("away");
    if (!home || !away) return Response.json({ ok: false, error: "home and away query params required" });

    const [model, meta, snapshot, predictions] = await Promise.all([
      redis.get("mlb-forest-model"),
      redis.get("mlb-forest-meta"),
      redis.get("mlb-snapshot"),
      redis.get("mlb-predictions"),
    ]);

    if (!model || !meta?.ready) {
      return Response.json({ ok: true, available: false, trainedOn: meta?.trainedOn ?? 0 });
    }

    const ratings = snapshot?.ratings || {};
    const homeAdv = snapshot?.homeAdv || {};
    const rH = ratings[home] ?? 1500, rA = ratings[away] ?? 1500;
    const ratingDiff = rH - rA;
    const homeAdvUsed = homeAdv[home] ?? 25;
    const formDiff = formDiffFor(predictions || {}, home, away, new Date().toISOString());

    const prob = predictGBoost(model, [ratingDiff, homeAdvUsed, formDiff]);
    return Response.json({
      ok: true, available: prob != null,
      homeWinProb: prob, trainedOn: meta.trainedOn, trainAccuracy: meta.trainAccuracy,
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
