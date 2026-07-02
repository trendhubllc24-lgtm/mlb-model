/* ================================================================== */
/*  STARTING PITCHER QUALITY — a rolling, point-in-time ERA computed    */
/*  from a pitcher's own last few starts, using only starts strictly    */
/*  before the game being predicted. Deliberately NOT their season-end  */
/*  ERA, which would leak starts that happen after the predicted game.  */
/*  Keyed by pitcher display name (matches ESPN's "probable starter"    */
/*  field format directly, avoiding an athlete-ID lookup for upcoming   */
/*  games where only the name is known ahead of time).                  */
/* ================================================================== */
const ERA_WINDOW = 5;      // last 5 starts
const MIN_STARTS_FOR_ERA = 3;
const LEAGUE_AVG_ERA = 4.2; // neutral fallback when a pitcher has no usable history yet

// pitcherStarts: { gameId: { date, home: {name, ip, er, k?, bb?, h?}, away: {...} } }
// k/bb/h only exist on entries fetched after the v2 extractor landed — the
// K-rate math below just skips starts that don't have them.
export function buildPitcherLogs(pitcherStarts) {
  const rows = [];
  for (const g of Object.values(pitcherStarts || {})) {
    if (!g?.date) continue;
    if (g.home?.name) rows.push({ name: g.home.name, date: g.date, ip: g.home.ip, er: g.home.er, k: g.home.k });
    if (g.away?.name) rows.push({ name: g.away.name, date: g.date, ip: g.away.ip, er: g.away.er, k: g.away.k });
  }
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));

  const logs = {};
  for (const r of rows) {
    if (!logs[r.name]) logs[r.name] = [];
    logs[r.name].push(r);
  }
  return logs;
}

export function pitcherEraAsOf(logs, name, beforeDate) {
  const log = name && logs[name];
  if (!log) return LEAGUE_AVG_ERA;
  const cutoff = new Date(beforeDate).getTime();
  const prior = log.filter((r) => new Date(r.date).getTime() < cutoff && r.ip > 0);
  const recent = prior.slice(-ERA_WINDOW);
  if (recent.length < MIN_STARTS_FOR_ERA) return LEAGUE_AVG_ERA;
  const totalER = recent.reduce((s, r) => s + r.er, 0);
  const totalIP = recent.reduce((s, r) => s + r.ip, 0);
  return totalIP > 0 ? (totalER * 9) / totalIP : LEAGUE_AVG_ERA;
}

// Rolling strikeout rate (K per 9 innings) over the same window. K-rate is
// noticeably more stable start-to-start than ERA (it doesn't swing on one
// bad inning of sequencing luck), so it complements the ERA gap rather
// than duplicating it. Only starts that actually carry a strikeout count
// (v2 pitcher data) participate; without enough of them the fallback is
// the league-average rate, which makes the resulting diff feature neutral.
const LEAGUE_AVG_K9 = 8.3;

export function pitcherK9AsOf(logs, name, beforeDate) {
  const log = name && logs[name];
  if (!log) return LEAGUE_AVG_K9;
  const cutoff = new Date(beforeDate).getTime();
  const prior = log.filter((r) => new Date(r.date).getTime() < cutoff && r.ip > 0 && r.k != null);
  const recent = prior.slice(-ERA_WINDOW);
  if (recent.length < MIN_STARTS_FOR_ERA) return LEAGUE_AVG_K9;
  const totalK = recent.reduce((s, r) => s + r.k, 0);
  const totalIP = recent.reduce((s, r) => s + r.ip, 0);
  return totalIP > 0 ? (totalK * 9) / totalIP : LEAGUE_AVG_K9;
}

// Positive = home starter has been pitching better lately than the away
// starter (lower ERA); this is the value fed to the model.
export function pitcherDiffFor(pitcherStarts, homeStarterName, awayStarterName, asOfDate) {
  const logs = buildPitcherLogs(pitcherStarts);
  const homeEra = pitcherEraAsOf(logs, homeStarterName, asOfDate);
  const awayEra = pitcherEraAsOf(logs, awayStarterName, asOfDate);
  return awayEra - homeEra; // lower home ERA (better) -> positive number
}
