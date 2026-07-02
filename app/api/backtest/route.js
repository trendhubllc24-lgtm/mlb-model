import { Redis } from "@upstash/redis";
import { crossValidate } from "@/lib/gboost";
import { buildTeamGameLogs, recentForm } from "@/lib/form";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();
const K = 5;
const MIN_ROWS = 200;

// Honest, retroactive evaluation of Gradient Boosting across EVERY graded
// game — not just new ones. Uses 5-fold cross-validation: trains 5 models,
// each held out from one slice of the data, and grades each game using
// only a model that never saw that specific game during training. Writes
// the honest out-of-fold pick back onto every historical prediction
// (gPick/gProbA/gCorrect), so the site's existing "Gradient Boosting"
// tracker section picks up all ~5,000+ games automatically on the next
// refresh — no separate UI needed.
//
// Note on methodology: this is standard k-fold cross-validation, which is
// an honest way to estimate accuracy across a full dataset — but it isn't
// a strict "as it would have happened in order" backtest, since a fold can
// include games from later dates than the one being graded. ratingDiff and
// homeAdvUsed are still the values captured at the time, so no game's own
// outcome leaks into its own prediction — but the model doing the grading
// may have learned from chronologically later games in other folds. Re-run
// this occasionally (e.g. after a big backfill) rather than continuously —
// it's a snapshot evaluation, not a live-updating stat.
export async function GET(req) {
  const authed = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!authed) return new Response("unauthorized", { status: 401 });

  try {
    const predictions = (await redis.get("mlb-predictions")) || {};
    const entries = Object.entries(predictions).filter(
      ([, p]) => p.resolved && typeof p.ratingDiff === "number" && typeof p.homeAdvUsed === "number"
    );
    entries.sort((a, b) => new Date(a[1].date) - new Date(b[1].date));

    if (entries.length < MIN_ROWS) {
      return Response.json({ ok: true, ready: false, total: entries.length, message: `Need at least ${MIN_ROWS} graded games first — you have ${entries.length}.` });
    }

    const logs = buildTeamGameLogs(predictions);
    const X = entries.map(([, p]) => {
      const formDiff = recentForm(logs[p.a], p.date) - recentForm(logs[p.b], p.date);
      return [p.ratingDiff, p.homeAdvUsed, formDiff];
    });
    const y = entries.map(([, p]) => (p.actual === "A" ? 1 : 0));

    const { preds, probs, correct, total, accuracy } = crossValidate(X, y, K);

    entries.forEach(([gid], i) => {
      if (preds[i] == null) return;
      predictions[gid].gPick = preds[i] === 1 ? "A" : "B";
      predictions[gid].gProbA = probs[i];
      predictions[gid].gCorrect = preds[i] === y[i];
    });
    await redis.set("mlb-predictions", predictions);

    const backtest = { accuracy, correct, incorrect: total - correct, total, k: K, computedAt: new Date().toISOString() };
    await redis.set("mlb-forest-backtest", backtest);
    const existing = (await redis.get("mlb-snapshot")) || {};
    await redis.set("mlb-snapshot", { ...existing, forestBacktest: backtest });

    return Response.json({ ok: true, ready: true, ...backtest });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
