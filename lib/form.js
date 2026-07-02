/* ================================================================== */
/*  RECENT SCORING FORM — a new feature computed fresh from games you   */
/*  already have graded, no new API calls or backfill needed. For a    */
/*  given team and a given date, looks at that team's last 10 games    */
/*  BEFORE that date (never after — that would leak the future into    */
/*  training) and returns their net scoring form: average runs scored  */
/*  minus average runs allowed. A team on a hot streak scoring a lot   */
/*  and allowing little gets a positive number; a cold/injury-riddled  */
/*  stretch gets negative, even if their long-run Elo rating hasn't    */
/*  caught up yet.                                                     */
/* ================================================================== */
const FORM_WINDOW = 10;
const MIN_GAMES_FOR_FORM = 3; // too little sample early in a team's history — fall back to neutral

// Rebuilds a full home/away-aware game log per team from the predictions
// object already stored in Redis. Pure function, no side effects.
export function buildTeamGameLogs(predictions) {
  const rows = Object.values(predictions || {}).filter((p) => p.resolved && p.finalScore);
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));

  const logs = {};
  for (const p of rows) {
    const parts = p.finalScore.split("-").map(Number);
    if (parts.length !== 2 || parts.some(Number.isNaN)) continue;
    const [homeRuns, awayRuns] = parts;
    if (!logs[p.a]) logs[p.a] = [];
    if (!logs[p.b]) logs[p.b] = [];
    logs[p.a].push({ date: p.date, runsFor: homeRuns, runsAgainst: awayRuns });
    logs[p.b].push({ date: p.date, runsFor: awayRuns, runsAgainst: homeRuns });
  }
  return logs; // { teamName: [{date, runsFor, runsAgainst}, ...] }, each already date-sorted ascending
}

// Net scoring form for one team, using only games strictly before `beforeDate`.
export function recentForm(gameLog, beforeDate) {
  if (!gameLog || gameLog.length === 0) return 0;
  const cutoff = new Date(beforeDate).getTime();
  const prior = gameLog.filter((g) => new Date(g.date).getTime() < cutoff);
  const recent = prior.slice(-FORM_WINDOW);
  if (recent.length < MIN_GAMES_FOR_FORM) return 0; // neutral fallback, not enough sample yet
  const avgFor = recent.reduce((s, g) => s + g.runsFor, 0) / recent.length;
  const avgAgainst = recent.reduce((s, g) => s + g.runsAgainst, 0) / recent.length;
  return avgFor - avgAgainst;
}

// Convenience: the differential feature actually fed to the model —
// home team's recent net form minus away team's recent net form.
export function formDiffFor(predictions, home, away, asOfDate) {
  const logs = buildTeamGameLogs(predictions);
  return recentForm(logs[home], asOfDate) - recentForm(logs[away], asOfDate);
}

/* ================================================================== */
/*  REST DAYS — how many full off-days a team had before this game,     */
/*  from the same game log (zero new API calls). Played yesterday = 0   */
/*  rest (the MLB norm); a doubleheader nightcap also counts as 0.      */
/*  Capped at 3 so the All-Star break and season openers read as        */
/*  "fully rested" instead of as absurd 90-day outliers.                */
/* ================================================================== */
const REST_CAP = 3;
const REST_NEUTRAL = 1; // no prior game on record -> typical in-season rest

const dayMs = 24 * 60 * 60 * 1000;
const dayKey = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export function restDaysAsOf(gameLog, beforeDate) {
  if (!gameLog || gameLog.length === 0) return REST_NEUTRAL;
  const cutoff = new Date(beforeDate).getTime();
  let prev = null;
  for (const g of gameLog) {
    const t = new Date(g.date).getTime();
    if (t >= cutoff) break; // log is date-sorted ascending
    prev = g;
  }
  if (!prev) return REST_NEUTRAL;
  const gap = Math.round((new Date(dayKey(beforeDate)) - new Date(dayKey(prev.date))) / dayMs);
  return Math.max(0, Math.min(REST_CAP, gap - 1));
}
