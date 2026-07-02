import { predictGBoost } from "./gboost.js";
import { buildFeatureContext, featuresFor } from "./features.js";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";
const ESPN_STANDINGS = "https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings";
const fmtDate = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
export const dayKeyOf = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // -> YYYY-MM-DD, sortable

// --- ESPN: multi-day slate + live MLB games, with real odds when published --
// FIX: this used to request a single exact day (dates=YYYYMMDD), which only
// returns that one calendar day — it silently dropped "today" whenever the
// UTC day boundary didn't line up with US evening games, and it never had
// more than one day of games for a schedule dropdown. Now requests a real
// range: yesterday (UTC safety buffer, same lesson as the World Cup build)
// through 7 days out, so there's always a full week of schedule to page
// through and "today" can never silently vanish.
function mapEvent(ev) {
  const comp = ev.competitions?.[0] || {};
  const home = comp.competitors?.find((c) => c.homeAway === "home");
  const away = comp.competitors?.find((c) => c.homeAway === "away");
  const odds = comp.odds?.[0] || {};
  const status = comp.status || {};
  return {
    id: ev.id,
    date: ev.date,
    seasonType: ev.season?.type, // 1=pre, 2=regular, 3=post — used to exclude spring training from training data
    state: status.type?.state, // "pre" | "in" | "post"
    home: home?.team?.displayName,
    away: away?.team?.displayName,
    homeScore: Number(home?.score ?? 0),
    awayScore: Number(away?.score ?? 0),
    city: comp.venue?.address?.city,
    venue: comp.venue?.fullName,
    homeML: odds.homeTeamOdds?.moneyLine,
    awayML: odds.awayTeamOdds?.moneyLine,
    overUnder: odds.overUnder,
    spread: odds.spread, // run line, usually ±1.5
    inning: status.period,           // 1-9 (or more, extras)
    half: status.type?.shortDetail?.match(/Top|Bot/i)?.[0] || null,
    liveDetail: status.type?.shortDetail,
    probableHome: home?.probables?.[0]?.athlete?.displayName,
    probableAway: away?.probables?.[0]?.athlete?.displayName,
  };
}

// Single confirmed-working ESPN call: one exact calendar day (YYYYMMDD).
// Never throws — a bad/network-failed day just contributes zero games
// instead of taking down whatever's calling it in a loop.
export async function getDaySlate(dateStr) {
  try {
    const url = `${ESPN_BASE}/scoreboard?dates=${dateStr}&limit=200`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.events || []).map(mapEvent);
  } catch {
    return [];
  }
}

// --- Today's slate + live games, with real odds when published -----------
// FIX: this used to send a single request with a date RANGE parameter
// (dates=START-END). That format isn't confirmed to work on this endpoint,
// and when it silently failed it took the whole /api/refresh call down with
// it (nothing else got saved either, including standings — which is why a
// stale standings shape from before this fix could crash the page). Now it
// fires one CONFIRMED-working single-day request per day, in parallel, so
// one bad day can never break the rest.
export async function getEspnSlate() {
  const days = [];
  for (let i = -1; i <= 7; i++) days.push(fmtDate(new Date(Date.now() + i * 24 * 60 * 60 * 1000)));
  const results = await Promise.all(days.map(getDaySlate));
  return results.flat();
}

export async function getEspnMatch(eventId) {
  const res = await fetch(`${ESPN_BASE}/summary?event=${eventId}`, { cache: "no-store" });
  return res.json();
}

// --- Starting pitcher extraction from box score ----------------------------
// Verified against a real ESPN box score response: boxscore.players[team]
// has a "pitching" statistics block whose athletes[] each carry a `starter`
// boolean — the true starter, not just whoever's listed first. Their
// per-game line (innings pitched, earned runs) is exactly what's needed to
// build a rolling, point-in-time ERA ourselves (see lib/pitcherForm.js) —
// this deliberately does NOT use ESPN's season-aggregate ERA field, since
// that would include starts that happen AFTER the game being predicted.
// MLB box-score IP notation: "5.1" = 5 innings + 1 out (not .1 decimal)
function parseIp(raw) {
  if (raw == null) return null;
  const [whole, part] = String(raw).split(".").map(Number);
  return (whole || 0) + (part || 0) / 3;
}

export async function getGamePitchers(eventId) {
  try {
    const sum = await getEspnMatch(eventId);
    const box = sum.boxscore;
    if (!box) return null;

    const homeAwayById = {};
    for (const t of box.teams || []) homeAwayById[t.team?.id] = t.homeAway;

    const result = {};
    const bullpen = {};
    for (const p of box.players || []) {
      const homeAway = homeAwayById[p.team?.id];
      if (!homeAway) continue;
      const pitching = (p.statistics || []).find((s) => s.type === "pitching");
      if (!pitching) continue;
      const starter = (pitching.athletes || []).find((a) => a.starter);
      if (!starter?.athlete?.displayName) continue;

      const keys = pitching.keys || [];
      const ipIdx = keys.indexOf("fullInnings.partInnings");
      const erIdx = keys.indexOf("earnedRuns");
      // extended starter stats (v2): strikeouts feed the rolling K/9 feature;
      // walks and hits are captured too so a WHIP feature later needs no
      // re-backfill. Missing keys just come through as undefined — every
      // consumer treats that as "not enough data" and stays neutral.
      const kIdx = keys.indexOf("strikeouts");
      const bbIdx = keys.indexOf("walks");
      const hIdx = keys.indexOf("hits");
      const statNum = (athlete, idx) => {
        if (idx < 0) return undefined;
        const n = Number(athlete.stats?.[idx]);
        return Number.isFinite(n) ? n : undefined;
      };

      const ip = parseIp(ipIdx >= 0 ? starter.stats?.[ipIdx] : null);
      const er = erIdx >= 0 ? Number(starter.stats?.[erIdx]) : null;
      if (ip != null && er != null) {
        result[homeAway] = {
          name: starter.athlete.displayName, ip, er,
          k: statNum(starter, kIdx), bb: statNum(starter, bbIdx), h: statNum(starter, hIdx),
        };
      }

      // Bullpen = every pitcher in the box score who ISN'T the starter,
      // summed into one team relief line. Same fetch, zero extra API calls.
      // A complete game legitimately produces {ip: 0, er: 0}.
      let bpIp = 0, bpEr = 0;
      for (const a of pitching.athletes || []) {
        if (a.starter) continue;
        const aIp = parseIp(ipIdx >= 0 ? a.stats?.[ipIdx] : null);
        const aEr = erIdx >= 0 ? Number(a.stats?.[erIdx]) : NaN;
        if (aIp != null && Number.isFinite(aEr)) { bpIp += aIp; bpEr += aEr; }
      }
      bullpen[homeAway] = { ip: Math.round(bpIp * 100) / 100, er: bpEr };
    }
    return (result.home && result.away) ? { ...result, bullpen } : null;
  } catch {
    return null;
  }
}

// --- Current injuries, per team (ESPN, no key) -----------------------------
// Display / situational context ONLY — there is no free source of
// point-in-time historical injury lists, so this can't honestly be a
// training feature (training on today's injury list against 2021 games
// would be nonsense). Shape is defensive: if ESPN changes the payload,
// this returns {} and nothing downstream breaks.
export async function getInjuries() {
  try {
    const res = await fetch(`${ESPN_BASE}/injuries`, { cache: "no-store" });
    if (!res.ok) return {};
    const data = await res.json();
    const byTeam = {};
    for (const t of data.injuries || []) {
      const teamName = t.displayName || t.team?.displayName;
      if (!teamName) continue;
      const players = (t.injuries || [])
        .map((inj) => ({
          name: inj.athlete?.displayName,
          position: inj.athlete?.position?.abbreviation,
          status: inj.status,
        }))
        .filter((p) => p.name);
      byTeam[teamName] = { count: players.length, players: players.slice(0, 15) };
    }
    return byTeam;
  } catch {
    return {};
  }
}

// --- Head-to-head, using the event id we already have (no re-fetch) -------
export async function getEspnH2H(gameId, teamA, teamB) {
  try {
    const sum = await getEspnMatch(gameId);
    const games = sum.headToHeadGames || [];
    let aWins = 0, bWins = 0;
    for (const g of games) {
      const comps = g.competitors || [];
      const winner = comps.find((c) => c.winner);
      if (winner?.team?.displayName === teamA) aWins++;
      else if (winner) bWins++;
    }
    const played = aWins + bWins;
    return played ? { played, aWins, bWins } : { played: 0, note: "No recent meetings on record." };
  } catch {
    return { played: 0, note: "H2H unavailable right now." };
  }
}

// --- Just the in-progress games, shaped for the "Live Now" ticker ---------
export function extractLiveGames(slate) {
  return slate
    .filter((g) => g.state === "in")
    .map((g) => ({
      id: g.id,
      a: g.home, b: g.away, aScore: g.homeScore, bScore: g.awayScore,
      clock: g.liveDetail || (g.half && g.inning ? `${g.half} ${g.inning}` : ""),
      inning: g.inning, city: g.city, stad: g.venue,
      homeML: g.homeML, awayML: g.awayML, overUnder: g.overUnder, spread: g.spread,
    }));
}

// --- MLB standings, grouped into real divisions, with home/road splits ----
// FIX: the old parser assumed `league.children` held per-division groups —
// that's not how ESPN's actual payload is shaped. ESPN returns each league
// (AL/NL) as one flat list of teams (`league.standings.entries`), not
// pre-split into East/Central/West. So this now groups them into divisions
// itself using a hardcoded 2026 division map, and also pulls each team's
// Home/Road W-L split (present in the same payload) so home-field advantage
// can be computed from real ESPN data instead of one flat guess for every
// team.
const DIVISIONS = {
  "AL East": ["Baltimore Orioles", "Boston Red Sox", "New York Yankees", "Tampa Bay Rays", "Toronto Blue Jays"],
  "AL Central": ["Chicago White Sox", "Cleveland Guardians", "Detroit Tigers", "Kansas City Royals", "Minnesota Twins"],
  "AL West": ["Houston Astros", "Los Angeles Angels", "Athletics", "Seattle Mariners", "Texas Rangers"],
  "NL East": ["Atlanta Braves", "Miami Marlins", "New York Mets", "Philadelphia Phillies", "Washington Nationals"],
  "NL Central": ["Chicago Cubs", "Cincinnati Reds", "Milwaukee Brewers", "Pittsburgh Pirates", "St. Louis Cardinals"],
  "NL West": ["Arizona Diamondbacks", "Colorado Rockies", "Los Angeles Dodgers", "San Diego Padres", "San Francisco Giants"],
};
const DIVISION_ORDER = Object.keys(DIVISIONS);
function divisionOf(teamName) {
  for (const [div, teams] of Object.entries(DIVISIONS)) if (teams.includes(teamName)) return div;
  return "Other";
}
function parseRecord(str) {
  if (!str) return null;
  const [w, l] = str.split("-").map(Number);
  const total = w + l;
  return total ? { w, l, pct: w / total } : null;
}

export async function getStandings() {
  try {
    const res = await fetch(ESPN_STANDINGS, { cache: "no-store" });
    const data = await res.json();
    const leagues = data.children || [];
    const grouped = {};

    for (const league of leagues) {
      const entries = league.standings?.entries || [];
      for (const e of entries) {
        const name = e.team?.displayName;
        if (!name) continue;
        const stat = (type) => e.stats?.find((s) => s.type === type);
        const home = parseRecord(stat("home")?.summary);
        const road = parseRecord(stat("road")?.summary);
        const div = divisionOf(name);
        if (!grouped[div]) grouped[div] = [];
        grouped[div].push({
          team: name,
          wins: stat("wins")?.value ?? 0,
          losses: stat("losses")?.value ?? 0,
          pct: stat("winpercent")?.value ?? 0,
          gb: stat("gamesbehind")?.displayValue ?? "-",
          streak: stat("streak")?.displayValue ?? "",
          homeRecord: stat("home")?.summary ?? null,
          roadRecord: stat("road")?.summary ?? null,
          homePct: home?.pct ?? null,
          roadPct: road?.pct ?? null,
        });
      }
    }

    return DIVISION_ORDER.filter((d) => grouped[d]?.length).map((name) => ({
      name,
      teams: grouped[name].sort((a, b) => b.pct - a.pct),
    }));
  } catch {
    return [];
  }
}

// --- Home-field advantage, derived from ESPN's real home/road splits ------
// This is genuinely sourced from ESPN (not guessed): each team's homePct
// minus roadPct is how many more games out of every 10 they win at home
// than on the road. That gets scaled into the same rating-point space the
// model already uses for team strength, so a team that's dramatically
// better at home (e.g. Colorado's altitude effect) gets a bigger boost than
// a team with almost no home/road split. Clamped so one small-sample outlier
// can't swing a game.
// NOTE ON KALSHI: Kalshi doesn't publish a per-team home-field stat — it
// only prices game winners and season futures, which the model already uses
// elsewhere (moneylines, World Series futures). There's no separate
// "Kalshi home-field number" to pull in honestly, so this is ESPN-only.
export function buildHomeAdvMap(standings) {
  const map = {};
  for (const div of standings || []) {
    for (const t of div.teams || []) {
      if (t.homePct == null || t.roadPct == null) continue;
      const edge = t.homePct - t.roadPct; // e.g. +0.15 = wins 15% more often at home
      const ratingBump = Math.max(-15, Math.min(90, 25 + edge * 260));
      map[t.team] = Math.round(ratingBump);
    }
  }
  return map;
}

// --- Polymarket (Gamma API, no key). slug e.g. "world-series-winner" -----
export async function getPolymarket(slug) {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, { cache: "no-store" });
    const [event] = await res.json();
    if (!event) return [];
    return (event.markets || [])
      .map((m) => {
        const prices = JSON.parse(m.outcomePrices || "[]").map(Number);
        return { label: m.groupItemTitle || m.question, prob: prices[0] || 0 };
      })
      .sort((a, b) => b.prob - a.prob);
  } catch {
    return [];
  }
}

// --- Kalshi (public markets GET, no key). Confirm ticker on kalshi.com ---
// Correct public base is external-api.kalshi.com, and prices can come back
// as either cents-integers or dollar-strings depending on the market — this
// reads whichever is present. Same lessons as the World Cup build.
export async function getKalshi(eventTicker) {
  try {
    const res = await fetch(
      `https://external-api.kalshi.com/trade-api/v2/markets?event_ticker=${eventTicker}&status=open`,
      { headers: { accept: "application/json" }, cache: "no-store" }
    );
    const data = await res.json();
    return (data.markets || []).map((m) => {
      const bid = m.yes_bid_dollars != null ? parseFloat(m.yes_bid_dollars) : (m.yes_bid ?? 0) / 100;
      const ask = m.yes_ask_dollars != null ? parseFloat(m.yes_ask_dollars) : (m.yes_ask ?? 0) / 100;
      return { label: m.yes_sub_title || m.title, prob: (bid + ask) / 2 };
    });
  } catch {
    return [];
  }
}

/* ================================================================== */
/*  RATINGS + MODEL MATH — Elo-style rating -> expected runs -> Poisson */
/*  grid. Ratings now LIVE IN REDIS and self-adjust after every graded  */
/*  game (see updateTrackRecord below), instead of being a fixed table  */
/*  forever. That adjustment is the "learning from misses" mechanism:   */
/*  a team that keeps outperforming its rating gets nudged up, a team   */
/*  that keeps underperforming gets nudged down, so the next prediction */
/*  for that team reflects recent reality, not just the day-one guess.  */
/* ================================================================== */
export const BASE_TEAM_RATING = {
  "Los Angeles Dodgers": 1620, "New York Yankees": 1600, "Atlanta Braves": 1580,
  "Philadelphia Phillies": 1575, "Houston Astros": 1565, "Baltimore Orioles": 1560,
  "Texas Rangers": 1545, "Arizona Diamondbacks": 1540, "Seattle Mariners": 1535,
  "San Diego Padres": 1530, "Milwaukee Brewers": 1525, "Minnesota Twins": 1520,
  "Cleveland Guardians": 1515, "Chicago Cubs": 1510, "Tampa Bay Rays": 1505,
  "New York Mets": 1520, "Boston Red Sox": 1515, "San Francisco Giants": 1500,
  "Toronto Blue Jays": 1500, "St. Louis Cardinals": 1490, "Detroit Tigers": 1485,
  "Cincinnati Reds": 1480, "Kansas City Royals": 1475, "Pittsburgh Pirates": 1460,
  "Los Angeles Angels": 1455, "Washington Nationals": 1450, "Miami Marlins": 1440,
  "Chicago White Sox": 1420, "Athletics": 1430, "Colorado Rockies": 1410,
};
const ELO_K = 20; // how hard one game's real result moves a team's rating

function pFactorial(n) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
function pPoisson(k, l) { return Math.exp(-l) * Math.pow(l, k) / pFactorial(k); }

// Predict moneyline win probability for a game — same Elo->Poisson shape as
// the World Cup model, adapted for runs (no draw; a tied-grid mass splits
// into a slight home-field edge, representing the extra-innings coinflip).
// `ratings` and `homeAdvMap` are optional overrides — pass the live,
// self-adjusted values from Redis; falls back to the static table/flat
// constant if not supplied (e.g. before the first refresh has ever run).
export function predictMatch(home, away, ratings, homeAdvMap) {
  const rH = ratings?.[home] ?? BASE_TEAM_RATING[home] ?? 1500;
  const rA = ratings?.[away] ?? BASE_TEAM_RATING[away] ?? 1500;
  const homeAdv = homeAdvMap?.[home] ?? 25;
  const diff = rH - rA + homeAdv;
  const sup = Math.max(-3, Math.min(3, diff / 140));
  const total = 8.6; // roughly MLB's combined runs/game league average
  const lH = Math.max(1.2, total / 2 + sup / 2), lA = Math.max(1.2, total / 2 - sup / 2);
  const MAXR = 12;
  let pH = 0, pA = 0, tie = 0;
  for (let i = 0; i <= MAXR; i++) for (let j = 0; j <= MAXR; j++) {
    const p = pPoisson(i, lH) * pPoisson(j, lA);
    if (i > j) pH += p; else if (i < j) pA += p; else tie += p;
  }
  pH += tie * 0.52; pA += tie * 0.48; // extra innings ~coinflip, tiny home edge
  const pick = pH >= pA ? "A" : "B";
  return { pA: pH, pB: pA, pick };
}

export async function updateTrackRecord(redis, slate, homeAdvMap) {
  const predictions = (await redis.get("mlb-predictions")) || {};
  const ratings = (await redis.get("mlb-ratings")) || { ...BASE_TEAM_RATING };

  // Gradient Boosting's own prediction gets logged and graded independently
  // right here, at the same moment as the Elo/Poisson one — using ONLY
  // information available at that moment (a snapshot of the game logs so
  // far), so it's a fair, out-of-sample comparison rather than hindsight.
  // The feature vector comes from the same shared builder /api/train uses,
  // so live prediction and training can never disagree on feature order.
  const gModel = await redis.get("mlb-forest-model");
  const ctx = gModel ? await buildFeatureContext(redis, predictions) : null;

  for (const g of slate) {
    const gid = String(g.id);
    if (!predictions[gid]) {
      const rH = ratings[g.home] ?? BASE_TEAM_RATING[g.home] ?? 1500;
      const rA = ratings[g.away] ?? BASE_TEAM_RATING[g.away] ?? 1500;
      const homeAdvUsed = homeAdvMap?.[g.home] ?? 25;
      const { pA, pB, pick } = predictMatch(g.home, g.away, ratings, homeAdvMap);

      let gPick = null, gProbA = null;
      if (ctx) {
        // g.probableHome/probableAway come straight from ESPN's pre-game
        // "probable starter" field — pitcher name only, no ID, which is
        // exactly what the pitcher logs are keyed by.
        const gProb = predictGBoost(gModel, featuresFor(ctx, {
          gid: null, home: g.home, away: g.away, date: g.date,
          ratingDiff: rH - rA, homeAdvUsed,
          probableHome: g.probableHome, probableAway: g.probableAway,
        }));
        if (gProb != null) { gProbA = gProb; gPick = gProb >= 0.5 ? "A" : "B"; }
      }

      predictions[gid] = {
        a: g.home, b: g.away, date: g.date, pA, pB, pick, resolved: false,
        ratingDiff: rH - rA, homeAdvUsed, gPick, gProbA,
        // Line-movement capture: the first moneyline ever seen for this game
        // is its "open". There's no free source of HISTORICAL line movement,
        // so this accumulates from today forward; once enough graded games
        // carry both an open and a close, movement can become a feature.
        openHomeML: g.homeML ?? null, openAwayML: g.awayML ?? null,
      };
    } else if (!predictions[gid].resolved && g.state === "pre" && g.homeML != null) {
      const p = predictions[gid];
      if (p.openHomeML == null) { p.openHomeML = g.homeML; p.openAwayML = g.awayML ?? null; }
      // keeps overwriting until first pitch — the last value seen is the
      // closing line, the sharpest public number there is
      p.closeHomeML = g.homeML; p.closeAwayML = g.awayML ?? null;
    }
    if (g.state === "post" && predictions[gid] && !predictions[gid].resolved) {
      const actual = g.homeScore > g.awayScore ? "A" : "B";
      predictions[gid].resolved = true;
      predictions[gid].actual = actual;
      predictions[gid].correct = actual === predictions[gid].pick;
      predictions[gid].finalScore = `${g.homeScore}-${g.awayScore}`;
      if (predictions[gid].gPick != null) {
        predictions[gid].gCorrect = actual === predictions[gid].gPick;
      }

      // --- Elo update: this is the "learning" step. The rating each team
      // carries into its NEXT predicted game shifts based on whether they
      // actually won or lost this one, versus what the rating expected.
      const rH = ratings[g.home] ?? BASE_TEAM_RATING[g.home] ?? 1500;
      const rA = ratings[g.away] ?? BASE_TEAM_RATING[g.away] ?? 1500;
      const expH = 1 / (1 + Math.pow(10, (rA - rH) / 400));
      const scoreH = actual === "A" ? 1 : 0;
      ratings[g.home] = rH + ELO_K * (scoreH - expH);
      ratings[g.away] = rA + ELO_K * ((1 - scoreH) - (1 - expH));
    }
  }

  await redis.set("mlb-predictions", predictions);
  await redis.set("mlb-ratings", ratings);

  const resolved = Object.values(predictions)
    .filter((p) => p.resolved)
    .sort((x, y) => new Date(y.date) - new Date(x.date));
  const correct = resolved.filter((p) => p.correct).length;
  const last10 = resolved.slice(0, 10);
  const last10Correct = last10.filter((p) => p.correct).length;

  // Gradient Boosting's own tracked record — only counts games it actually
  // made a logged, out-of-sample call on (gCorrect is undefined for every
  // game backfilled before the model existed, and for any game a model
  // wasn't trained yet when it first appeared).
  const gRows = resolved.filter((p) => p.gCorrect !== undefined);
  const gCorrect = gRows.filter((p) => p.gCorrect).length;

  return {
    correct, incorrect: resolved.length - correct, total: resolved.length,
    accuracy: resolved.length ? correct / resolved.length : null,
    recentAccuracy: last10.length ? last10Correct / last10.length : null,
    recentTotal: last10.length,
    history: resolved.slice(0, 50),
    ratings,
    gCorrect, gIncorrect: gRows.length - gCorrect, gTotal: gRows.length,
    gAccuracy: gRows.length ? gCorrect / gRows.length : null,
  };
}
