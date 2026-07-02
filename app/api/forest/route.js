import { Redis } from "@upstash/redis";
import { predictGBoost } from "@/lib/gboost";
import { buildFeatureContext, featuresFor, FEATURE_NAMES } from "@/lib/features";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();

// Public, read-only: given a home/away team, returns the Gradient Boosted
// Trees model's independent win-probability read for that matchup, as of
// right now, using the SAME shared feature builder training uses (this
// route previously hand-built a 3-feature vector while the model had
// grown to 4 — exactly the drift lib/features.js exists to prevent).
// Optional query params homeStarter/awayStarter (ESPN display names, e.g.
// "Gerrit Cole") sharpen the pitching features; without them those
// features sit at their neutral league-average values.
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
    const ctx = await buildFeatureContext(redis, predictions || {});
    const features = featuresFor(ctx, {
      gid: null, home, away, date: new Date().toISOString(),
      ratingDiff: (ratings[home] ?? 1500) - (ratings[away] ?? 1500),
      homeAdvUsed: homeAdv[home] ?? 25,
      probableHome: url.searchParams.get("homeStarter") || undefined,
      probableAway: url.searchParams.get("awayStarter") || undefined,
    });

    const prob = predictGBoost(model, features);
    return Response.json({
      ok: true, available: prob != null,
      homeWinProb: prob,
      features: Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, features[i]])),
      trainedOn: meta.trainedOn, trainAccuracy: meta.trainAccuracy,
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
