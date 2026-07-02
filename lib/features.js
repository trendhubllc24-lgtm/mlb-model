/* ================================================================== */
/*  FEATURE BUILDER — the ONE place the model's feature vector is       */
/*  defined. /api/train, /api/backtest, and the live prediction path    */
/*  in updateTrackRecord all call these two functions, so the feature   */
/*  order and math literally cannot drift apart between training and    */
/*  prediction.                                                         */
/*                                                                       */
/*  Every feature is point-in-time: computed only from information      */
/*  knowable BEFORE the game being predicted. Missing data always       */
/*  degrades to a neutral value, never to garbage or a throw.           */
/*                                                                       */
/*  PRUNED 2026-07-02: went from 10 features down to 6. The full         */
/*  10-feature model was trained and cross-validated (see git history —  */
/*  "expand model to 10 features"); restDiff carried ~0.1% of the        */
/*  model's total split-gain (dead weight — MLB rest gaps rarely swing   */
/*  outcomes) and parkFactor/parkTemp/parkWind, despite non-trivial      */
/*  importance shares, produced ZERO improvement in cross-validated      */
/*  (held-out) accuracy when added — high importance + flat held-out     */
/*  accuracy is the signature of a tree model fitting noise on           */
/*  high-cardinality continuous features, not finding real weather/park  */
/*  effects. Removed rather than kept "just in case": lib/parks.js and   */
/*  lib/weather.js (+ /api/backfill-weather) are left in place, so       */
/*  reintroducing park/weather later needs no new backfill — just        */
/*  re-adding a couple of lines here.                                    */
/* ================================================================== */
import { buildTeamGameLogs, recentForm } from "./form.js";
import { buildPitcherLogs, pitcherEraAsOf, pitcherK9AsOf } from "./pitcherForm.js";
import { buildBullpenLogs, bullpenEraAsOf } from "./bullpenForm.js";

export const FEATURE_NAMES = [
  "ratingDiff",   // home Elo rating minus away Elo rating
  "homeAdvUsed",  // ESPN-derived home-field edge, in rating points
  "formDiff",     // recent net scoring form gap (last 10 games)
  "pitcherDiff",  // starter rolling-ERA gap (away ERA minus home ERA; + = home better)
  "pitcherKDiff", // starter rolling K/9 gap (home minus away; + = home better) — highest-importance new feature
  "bullpenDiff",  // bullpen rolling-ERA gap (away minus home; + = home better)
];

// Loads + precomputes everything featuresFor needs, ONCE per request —
// building these logs per-game instead would re-sort thousands of rows
// for every row of training data.
export async function buildFeatureContext(redis, predictions) {
  const pitcherStarts = (await redis.get("mlb-pitcher-starts")) || {};
  return {
    pitcherStarts,
    teamLogs: buildTeamGameLogs(predictions),
    pitcherLogs: buildPitcherLogs(pitcherStarts),
    bullpenLogs: buildBullpenLogs(pitcherStarts, predictions),
  };
}

// One game -> one feature row, in FEATURE_NAMES order.
// For graded games the starters come from the backfilled box score
// (pitcherStarts[gid]); for upcoming games they fall back to ESPN's
// pre-game "probable starter" names — the same name-keyed lookup either way.
export function featuresFor(ctx, g) {
  const { gid, home, away, date, ratingDiff, homeAdvUsed, probableHome, probableAway } = g;

  const formDiff = recentForm(ctx.teamLogs[home], date) - recentForm(ctx.teamLogs[away], date);

  const starters = gid != null ? ctx.pitcherStarts[gid] : null;
  const homeStarter = starters && !starters.unavailable ? starters.home?.name : probableHome;
  const awayStarter = starters && !starters.unavailable ? starters.away?.name : probableAway;
  const pitcherDiff = pitcherEraAsOf(ctx.pitcherLogs, awayStarter, date) - pitcherEraAsOf(ctx.pitcherLogs, homeStarter, date);
  const pitcherKDiff = pitcherK9AsOf(ctx.pitcherLogs, homeStarter, date) - pitcherK9AsOf(ctx.pitcherLogs, awayStarter, date);

  const bullpenDiff = bullpenEraAsOf(ctx.bullpenLogs, away, date) - bullpenEraAsOf(ctx.bullpenLogs, home, date);

  return [ratingDiff, homeAdvUsed, formDiff, pitcherDiff, pitcherKDiff, bullpenDiff];
}
