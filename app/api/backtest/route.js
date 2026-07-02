import { Redis } from "@upstash/redis";
import { crossValidate } from "@/lib/gboost";
import { buildTeamGameLogs, recentForm } from "@/lib/form";
import { buildPitcherLogs, pitcherEraAsOf } from "@/lib/pitcherForm";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();
const K = 5;
const MIN_ROWS = 200;

// Honest, retroactive evaluation of Gradient Boosting across EVERY graded
// game — not just new ones. Uses 5-fold cross-validation: trains 5 models,
// each held out from one slice of the data, and grades each game using
// only a model that never saw that specific game during training. Now uses
// 4 features (ratingDiff, homeAdvUsed, formDiff, pitcherDiff) — same set
// /api/train uses. Writes the honest out-of-fold pick back onto every
// historical prediction (gPick/gProbA/gCorrect), so the site's existing
// "Gradient Boosting" tracker section picks up all graded games
// automatically on the next refresh — no separate UI needed.
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

    const teamLogs = buildTeamGameLogs(predictions);
    const pitcherStarts = (await redis.get("mlb-pitcher-starts")) || {};
    const pitcherLogs = buildPitcherLogs(pitcherStarts);
    const pitcherCoverage = entries.filter(([gid]) => pitcherStarts[gid] && !pitcherStarts[gid].unavailable).length;

    const X = entries.map(([gid, p]) => {
      const formDiff = recentForm(teamLogs[p.a], p.date) - recentForm(teamLogs[p.b], p.date);
      const starters = pitcherStarts[gid];
      const pitcherDiff = (starters && !starters.unavailable)
        ? pitcherEraAsOf(pitcherLogs, starters.away.name, p.date) - pitcherEraAsOf(pitcherLogs, starters.home.name, p.date)
        : 0;
      return [p.ratingDiff, p.homeAdvUsed, formDiff, pitcherDiff];
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

    const backtest = { accuracy, correct, incorrect: total - correct, total, k: K, pitcherCoverage, totalGames: entries.length, computedAt: new Date().toISOString() };
    await redis.set("mlb-forest-backtest", backtest);
    const existing = (await redis.get("mlb-snapshot")) || {};
    await redis.set("mlb-snapshot", { ...existing, forestBacktest: backtest });

    return Response.json({ ok: true, ready: true, ...backtest });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
