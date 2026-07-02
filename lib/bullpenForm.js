/* ================================================================== */
/*  BULLPEN STRENGTH — a rolling, point-in-time relief-corps ERA per    */
/*  TEAM, from the combined line of every non-starting pitcher in each  */
/*  game's box score. Comes from the exact same ESPN box-score fetch    */
/*  as the starting pitchers (see getGamePitchers), so it costs zero    */
/*  extra API calls — it just needed extracting.                        */
/*                                                                       */
/*  Same anti-leakage rule as everything else: for a game on date D,    */
/*  only bullpen outings strictly BEFORE D count. Season-aggregate      */
/*  bullpen ERA would include relief outings after the predicted game.  */
/*                                                                       */
/*  pitcherStarts entries are keyed by gameId but don't carry team      */
/*  names, so this joins against the predictions object (which has      */
/*  a = home team, b = away team for the same gameId).                  */
/* ================================================================== */
const BULLPEN_WINDOW = 15;      // last 15 games of relief work
const MIN_GAMES_FOR_BULLPEN = 5;
const LEAGUE_AVG_BULLPEN_ERA = 4.1; // neutral fallback

// pitcherStarts v2 entries carry: bullpen: { home: {ip, er}, away: {ip, er} }
export function buildBullpenLogs(pitcherStarts, predictions) {
  const rows = [];
  for (const [gid, g] of Object.entries(pitcherStarts || {})) {
    const p = predictions?.[gid];
    if (!p || !g?.bullpen || !g.date) continue;
    if (g.bullpen.home) rows.push({ team: p.a, date: g.date, ip: g.bullpen.home.ip, er: g.bullpen.home.er });
    if (g.bullpen.away) rows.push({ team: p.b, date: g.date, ip: g.bullpen.away.ip, er: g.bullpen.away.er });
  }
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));

  const logs = {};
  for (const r of rows) {
    if (!logs[r.team]) logs[r.team] = [];
    logs[r.team].push(r);
  }
  return logs; // { teamName: [{date, ip, er}, ...] } date-sorted ascending
}

export function bullpenEraAsOf(logs, team, beforeDate) {
  const log = team && logs?.[team];
  if (!log) return LEAGUE_AVG_BULLPEN_ERA;
  const cutoff = new Date(beforeDate).getTime();
  const prior = log.filter((r) => new Date(r.date).getTime() < cutoff);
  const recent = prior.slice(-BULLPEN_WINDOW);
  if (recent.length < MIN_GAMES_FOR_BULLPEN) return LEAGUE_AVG_BULLPEN_ERA;
  const totalER = recent.reduce((s, r) => s + (r.er || 0), 0);
  const totalIP = recent.reduce((s, r) => s + (r.ip || 0), 0);
  // a stretch of complete games (near-zero bullpen IP) is a sample-size
  // problem, not a 0.00-ERA bullpen — fall back rather than divide by ~0
  if (totalIP < 10) return LEAGUE_AVG_BULLPEN_ERA;
  return (totalER * 9) / totalIP;
}
