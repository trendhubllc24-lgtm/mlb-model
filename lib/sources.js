const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";
const ESPN_STANDINGS = "https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings";
const fmtDate = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

// --- ESPN: today's + live MLB games, with real odds when published -------
// MLB's schedule is daily (not a fixed bracket like a tournament), so unlike
// the World Cup model this doesn't need a multi-week date range — just
// "yesterday through today" as a UTC-boundary safety buffer, same lesson
// learned from the World Cup build (US evening = already tomorrow in UTC).
export async function getEspnSlate() {
  const start = fmtDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const url = `${ESPN_BASE}/scoreboard?dates=${start}&limit=100`;
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();
  return (data.events || []).map((ev) => {
    const comp = ev.competitions?.[0] || {};
    const home = comp.competitors?.find((c) => c.homeAway === "home");
    const away = comp.competitors?.find((c) => c.homeAway === "away");
    const odds = comp.odds?.[0] || {};
    const status = comp.status || {};
    return {
      id: ev.id,
      date: ev.date,
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
      probableHome: comp.competitors?.find((c) => c.homeAway === "home")?.probables?.[0]?.athlete?.displayName,
      probableAway: comp.competitors?.find((c) => c.homeAway === "away")?.probables?.[0]?.athlete?.displayName,
    };
  });
}

export async function getEspnMatch(eventId) {
  const res = await fetch(`${ESPN_BASE}/summary?event=${eventId}`, { cache: "no-store" });
  return res.json();
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
      a: g.home, b: g.away, aScore: g.homeScore, bScore: g.awayScore,
      clock: g.liveDetail || (g.half && g.inning ? `${g.half} ${g.inning}` : ""),
      inning: g.inning, city: g.city, stad: g.venue,
      homeML: g.homeML, awayML: g.awayML, overUnder: g.overUnder, spread: g.spread,
    }));
}

// --- MLB standings, by division — no bracket in a 162-game season ---------
export async function getStandings() {
  try {
    const res = await fetch(ESPN_STANDINGS, { cache: "no-store" });
    const data = await res.json();
    const groups = data.children || [];
    return groups.map((league) => ({
      league: league.name,
      divisions: (league.children || []).map((div) => ({
        name: div.name,
        teams: (div.standings?.entries || []).map((e) => ({
          team: e.team?.displayName,
          wins: e.stats?.find((s) => s.name === "wins")?.value ?? 0,
          losses: e.stats?.find((s) => s.name === "losses")?.value ?? 0,
          pct: e.stats?.find((s) => s.name === "winPercent")?.value ?? 0,
          gb: e.stats?.find((s) => s.name === "gamesBehind")?.displayValue ?? "-",
        })).sort((a, b) => b.pct - a.pct),
      })),
    }));
  } catch {
    return [];
  }
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
/*  TRACK RECORD — same mechanic as the World Cup model: log a          */
/*  pre-game prediction the moment a game appears, grade it once it's   */
/*  final. Baseball has no draws, so the pick is just moneyline A vs B. */
/* ================================================================== */
const TEAM_RATING = {
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
const rating = (name) => TEAM_RATING[name] ?? 1500;

function pFactorial(n) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
function pPoisson(k, l) { return Math.exp(-l) * Math.pow(l, k) / pFactorial(k); }

// Predict moneyline win probability for a game — same Elo→Poisson shape as
// the World Cup model, adapted for runs (no draw; a tied-grid mass splits
// into a slight home-field edge, representing the extra-innings coinflip).
export function predictMatch(home, away) {
  const diff = rating(home) - rating(away) + 25; // home field bump baked in
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

export async function updateTrackRecord(redis, slate) {
  const predictions = (await redis.get("mlb-predictions")) || {};

  for (const g of slate) {
    const gid = String(g.id);
    if (!predictions[gid]) {
      const { pA, pB, pick } = predictMatch(g.home, g.away);
      predictions[gid] = { a: g.home, b: g.away, date: g.date, pA, pB, pick, resolved: false };
    }
    if (g.state === "post" && predictions[gid] && !predictions[gid].resolved) {
      const actual = g.homeScore > g.awayScore ? "A" : "B";
      predictions[gid].resolved = true;
      predictions[gid].actual = actual;
      predictions[gid].correct = actual === predictions[gid].pick;
      predictions[gid].finalScore = `${g.homeScore}-${g.awayScore}`;
    }
  }

  await redis.set("mlb-predictions", predictions);

  const resolved = Object.values(predictions)
    .filter((p) => p.resolved)
    .sort((x, y) => new Date(y.date) - new Date(x.date));
  const correct = resolved.filter((p) => p.correct).length;

  return {
    correct, incorrect: resolved.length - correct, total: resolved.length,
    accuracy: resolved.length ? correct / resolved.length : null,
    history: resolved.slice(0, 50),
  };
}
