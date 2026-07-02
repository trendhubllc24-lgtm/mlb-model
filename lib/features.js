/* ================================================================== */
/*  FEATURE BUILDER — the ONE place the model's feature vector is       */
/*  defined. /api/train, /api/backtest, and the live prediction path    */
/*  in updateTrackRecord all call these two functions, so the feature   */
/*  order and math literally cannot drift apart between training and    */
/*  prediction (with 4 features that was already computed in three      */
/*  separate places; at 10 features a silent mismatch would be          */
/*  inevitable and invisible).                                          */
/*                                                                       */
/*  Every feature is point-in-time: computed only from information      */
/*  knowable BEFORE the game being predicted. Missing data always       */
/*  degrades to a neutral value, never to garbage or a throw.           */
/* ================================================================== */
import { buildTeamGameLogs, recentForm, restDaysAsOf } from "./form.js";
import { buildPitcherLogs, pitcherEraAsOf, pitcherK9AsOf } from "./pitcherForm.js";
import { buildBullpenLogs, bullpenEraAsOf } from "./bullpenForm.js";
import { parkInfoFor } from "./parks.js";
import { loadWeatherMaps, weatherFor } from "./weather.js";

export const FEATURE_NAMES = [
  "ratingDiff",   // home Elo rating minus away Elo rating
  "homeAdvUsed",  // ESPN-derived home-field edge, in rating points
  "formDiff",     // recent net scoring form gap (last 10 games)
  "pitcherDiff",  // starter rolling-ERA gap (away ERA minus home ERA; + = home better)
  "pitcherKDiff", // starter rolling K/9 gap (home minus away; + = home better)
  "restDiff",     // rest-day gap, each side capped at 3
  "bullpenDiff",  // bullpen rolling-ERA gap (away minus home; + = home better)
  "parkFactor",   // home park run factor (1.00 neutral, Coors 1.28)
  "parkTemp",     // game-day high at the park, °C (dome = fixed 22)
  "parkWind",     // game-day max wind at the park, km/h (dome = 0)
];

// Loads + precomputes everything featuresFor needs, ONCE per request —
// building these logs per-game instead would re-sort thousands of rows
// for every row of training data.
export async function buildFeatureContext(redis, predictions) {
  const pitcherStarts = (await redis.get("mlb-pitcher-starts")) || {};
  const weatherMaps = await loadWeatherMaps(redis);
  return {
    pitcherStarts,
    weatherMaps,
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

  const restDiff = restDaysAsOf(ctx.teamLogs[home], date) - restDaysAsOf(ctx.teamLogs[away], date);
  const bullpenDiff = bullpenEraAsOf(ctx.bullpenLogs, away, date) - bullpenEraAsOf(ctx.bullpenLogs, home, date);

  const park = parkInfoFor(home, date);
  const { temp, wind } = weatherFor(ctx.weatherMaps, home, date, park);

  return [ratingDiff, homeAdvUsed, formDiff, pitcherDiff, pitcherKDiff, restDiff, bullpenDiff, park.factor, temp, wind];
}
