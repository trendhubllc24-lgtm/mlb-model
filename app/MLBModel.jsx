"use client";
import { useState, useMemo, useEffect } from "react";

/* ================================================================== */
/*  TEAMS  (approximate power ratings, editable — same idea as the      */
/*  World Cup model's Elo table, scaled for baseball)                   */
/* ================================================================== */
const TEAMS = [
  ["Los Angeles Dodgers", "LAD", 1620], ["New York Yankees", "NYY", 1600],
  ["Atlanta Braves", "ATL", 1580], ["Philadelphia Phillies", "PHI", 1575],
  ["Houston Astros", "HOU", 1565], ["Baltimore Orioles", "BAL", 1560],
  ["Texas Rangers", "TEX", 1545], ["Arizona Diamondbacks", "ARI", 1540],
  ["Seattle Mariners", "SEA", 1535], ["San Diego Padres", "SD", 1530],
  ["Milwaukee Brewers", "MIL", 1525], ["Minnesota Twins", "MIN", 1520],
  ["New York Mets", "NYM", 1520], ["Cleveland Guardians", "CLE", 1515],
  ["Boston Red Sox", "BOS", 1515], ["Chicago Cubs", "CHC", 1510],
  ["Tampa Bay Rays", "TB", 1505], ["San Francisco Giants", "SF", 1500],
  ["Toronto Blue Jays", "TOR", 1500], ["St. Louis Cardinals", "STL", 1490],
  ["Detroit Tigers", "DET", 1485], ["Cincinnati Reds", "CIN", 1480],
  ["Kansas City Royals", "KC", 1475], ["Pittsburgh Pirates", "PIT", 1460],
  ["Los Angeles Angels", "LAA", 1455], ["Washington Nationals", "WSH", 1450],
  ["Miami Marlins", "MIA", 1440], ["Chicago White Sox", "CWS", 1420],
  ["Athletics", "ATH", 1430], ["Colorado Rockies", "COL", 1410],
].map(([name, abbr, rating]) => ({ name, abbr, rating })).sort((a, b) => a.name.localeCompare(b.name));
const byName = (n) => TEAMS.find((t) => t.name === n) || { name: n, abbr: (n || "").slice(0, 3).toUpperCase(), rating: 1500 };

/* Top hitters per team: ["name", HR share of team's expected runs] —
   shares are much smaller than the soccer model's scorer shares, since a
   home run is a rarer event than a goal relative to total runs scored. */
const HITTERS = {
  "Los Angeles Dodgers": [["Ohtani", 0.045], ["Freeman", 0.03], ["Betts", 0.028]],
  "New York Yankees": [["Judge", 0.05], ["Stanton", 0.032], ["Chisholm", 0.024]],
  "Atlanta Braves": [["Acuña Jr.", 0.035], ["Olson", 0.033], ["Riley", 0.028]],
  "Philadelphia Phillies": [["Schwarber", 0.04], ["Harper", 0.032], ["Realmuto", 0.02]],
  "Houston Astros": [["Alvarez", 0.036], ["Tucker", 0.03], ["Bregman", 0.026]],
  "Baltimore Orioles": [["Henderson", 0.03], ["Rutschman", 0.024], ["Mountcastle", 0.024]],
  "Texas Rangers": [["Seager", 0.03], ["Semien", 0.024], ["Garcia", 0.024]],
  "Arizona Diamondbacks": [["Carroll", 0.026], ["Marte", 0.024], ["Walker", 0.028]],
  "Seattle Mariners": [["Rodriguez", 0.032], ["Raleigh", 0.034], ["Suarez", 0.028]],
  "San Diego Padres": [["Tatis Jr.", 0.032], ["Machado", 0.028], ["Bogaerts", 0.022]],
  "Milwaukee Brewers": [["Yelich", 0.026], ["Contreras", 0.024]],
  "Minnesota Twins": [["Correa", 0.026], ["Buxton", 0.026], ["Lewis Jr.", 0.022]],
  "New York Mets": [["Lindor", 0.026], ["Alonso", 0.038], ["Nimmo", 0.02]],
  "Cleveland Guardians": [["Ramirez", 0.03], ["Kwan", 0.016]],
  "Boston Red Sox": [["Devers", 0.032], ["Story", 0.022]],
  "Chicago Cubs": [["Happ", 0.022], ["Swanson", 0.02], ["Suzuki", 0.02]],
  "Tampa Bay Rays": [["Arozarena", 0.024], ["Diaz", 0.022]],
  "San Francisco Giants": [["Chapman", 0.026], ["Yastrzemski", 0.02]],
  "Toronto Blue Jays": [["Guerrero Jr.", 0.036], ["Bichette", 0.024]],
  "St. Louis Cardinals": [["Arenado", 0.024], ["Goldschmidt", 0.024]],
  "Detroit Tigers": [["Torkelson", 0.026], ["Carpenter", 0.024]],
  "Cincinnati Reds": [["De La Cruz", 0.028], ["Steer", 0.02]],
  "Kansas City Royals": [["Witt Jr.", 0.028], ["Pasquantino", 0.022]],
  "Pittsburgh Pirates": [["Reynolds", 0.024], ["Cruz", 0.024]],
  "Los Angeles Angels": [["Trout", 0.034], ["Ward", 0.022]],
  "Washington Nationals": [["Abrams", 0.02], ["Wood", 0.022]],
  "Miami Marlins": [["De La Cruz Jr.", 0.02]],
  "Chicago White Sox": [["Vaughn", 0.022]],
  "Athletics": [["Langeliers", 0.02]],
  "Colorado Rockies": [["Doyle", 0.02]],
};

/* ================================================================== */
/*  MODEL MATH  — Elo-style rating → expected runs → Poisson grid.      */
/*  No Dixon-Coles low-score correction here (that was specifically a   */
/*  soccer fix for 0-0/1-0 clustering); baseball doesn't need it.       */
/* ================================================================== */
const HOME_ADV = 25, MAXR = 12;
function pFactorial(n) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
function poisson(k, l) { return Math.exp(-l) * Math.pow(l, k) / pFactorial(k); }
function deriveLambdas(rHome, rAway) {
  const diff = rHome - rAway + HOME_ADV;
  const sup = Math.max(-3, Math.min(3, diff / 140));
  const total = 8.6; // roughly MLB's combined runs/game league average
  return [Math.max(1.2, total / 2 + sup / 2), Math.max(1.2, total / 2 - sup / 2)];
}
function buildGrid(lH, lA) {
  const g = []; let s = 0;
  for (let i = 0; i <= MAXR; i++) { g[i] = []; for (let j = 0; j <= MAXR; j++) { const p = poisson(i, lH) * poisson(j, lA); g[i][j] = p; s += p; } }
  for (let i = 0; i <= MAXR; i++) for (let j = 0; j <= MAXR; j++) g[i][j] /= s;
  return g;
}
function summarize(grid) {
  let pH = 0, pA = 0, tie = 0, o75 = 0, o85 = 0, o95 = 0;
  const margH = Array(MAXR + 1).fill(0), margA = Array(MAXR + 1).fill(0), tot = Array(2 * MAXR + 1).fill(0);
  let peak = { i: 0, j: 0, p: 0 };
  const scores = [];
  for (let i = 0; i <= MAXR; i++) for (let j = 0; j <= MAXR; j++) {
    const p = grid[i][j];
    if (i > j) pH += p; else if (i < j) pA += p; else tie += p;
    if (i + j > 7.5) o75 += p; if (i + j > 8.5) o85 += p; if (i + j > 9.5) o95 += p;
    margH[i] += p; margA[j] += p; tot[i + j] += p;
    if (p > peak.p) peak = { i, j, p };
    if (i <= 9 && j <= 9) scores.push({ i, j, p });
  }
  pH += tie * 0.52; pA += tie * 0.48; // extra innings ~coinflip w/ slight home edge
  scores.sort((a, b) => b.p - a.p);
  const runline = (line, side) => {
    let p = 0;
    for (let i = 0; i <= MAXR; i++) for (let j = 0; j <= MAXR; j++) {
      const diff = i - j;
      if (side === "H" && diff > line) p += grid[i][j];
      if (side === "A" && -diff > -line) p += grid[i][j];
    }
    return p;
  };
  return { pH, pA, o75, o85, o95, margH, margA, tot, peak, top: scores.slice(0, 6), runline };
}
const overFrom = (arr, line) => { let s = 0; for (let k = Math.ceil(line + 0.01); k < arr.length; k++) s += arr[k]; return s; };
const anytime = (lambda, share) => 1 - Math.exp(-lambda * share);
const brace = (mu) => 1 - Math.exp(-mu) * (1 + mu);
function impliedProb(str) { const v = parseFloat(str); if (!str || isNaN(v)) return null; return v >= 0 ? 100 / (v + 100) : -v / (-v + 100); }
function fairAmerican(p) { if (p <= 0.001 || p >= 0.999) return "—"; return p > 0.5 ? "-" + Math.round(100 * p / (1 - p)) : "+" + Math.round(100 * (1 - p) / p); }

/* fallback snapshot (used before the backend is deployed / reachable) */
const SNAPSHOT = {
  asOf: "today", winner: [], schedule: [],
  note: "Deploy the backend for live ESPN + Polymarket + Kalshi pulls.",
};

const MINT = "#4FD8B0", CORAL = "#FF6B5C", AMBER = "#F2C14E";
const p1 = (x) => (x * 100).toFixed(1) + "%";

export default function MLBModel() {
  const [teamH, setTH] = useState("New York Yankees");
  const [teamA, setTA] = useState("Boston Red Sox");
  const [tab, setTab] = useState("risk");
  const [ttab, setTtab] = useState("upcoming");
  const [matchCity, setMatchCity] = useState(null);
  const [mktAuto, setMktAuto] = useState(null);
  const [nonce, setNonce] = useState(0);
  const [refreshed, setRefreshed] = useState(null);
  const [live, setLive] = useState(null);
  const [feed, setFeed] = useState("offline");

  const [bet, setBet] = useState("mlH");
  const [si, setSi] = useState(4); const [sj, setSj] = useState(3);
  const [ouLine, setOuLine] = useState(8.5); const [ouSide, setOuSide] = useState("over");
  const [ttTeam, setTtTeam] = useState("H"); const [ttLine, setTtLine] = useState(4.5);
  const [kLine, setKLine] = useState(5.5); const [kSide, setKSide] = useState("over");
  const [player, setPlayer] = useState("");

  const H = byName(teamH), A = byName(teamA);
  const pickH = (n) => setTH(n);
  const pickA = (n) => setTA(n);
  const loadFixture = (fx) => {
    pickH(fx.a); pickA(fx.b);
    setMatchCity(fx.city || null);
    setMktAuto((fx.homeML || fx.awayML || fx.overUnder) ? { h: fx.homeML, a: fx.awayML, o: fx.overUnder } : null);
    setTab("risk");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  useEffect(() => {
    let ok = true;
    const pull = (first) => {
      if (first) setFeed("loading");
      fetch("/api/snapshot").then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (ok && d) { setLive(d); setFeed("live"); } else if (first) setFeed("offline");
      }).catch(() => { if (ok && first) setFeed("offline"); });
    };
    pull(true);
    const id = setInterval(() => pull(false), 60000);
    return () => { ok = false; clearInterval(id); };
  }, []);

  const [liveGames, setLiveGames] = useState([]);
  const [syncedAt, setSyncedAt] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let ok = true;
    const pull = () => fetch("/api/live").then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (ok && d && d.live) { setLiveGames(d.live); setSyncedAt(Date.now()); } }).catch(() => {});
    pull();
    const id = setInterval(pull, 10000);
    return () => { ok = false; clearInterval(id); };
  }, []);
  useEffect(() => {
    if (liveGames.length === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [liveGames.length]);

  const M = useMemo(() => {
    const [lH, lA] = deriveLambdas(H.rating, A.rating);
    const grid = buildGrid(lH, lA);
    const s = summarize(grid);
    return { lH, lA, grid, s };
    // eslint-disable-next-line
  }, [teamH, teamA, nonce]);
  const { lH, lA, grid, s } = M;

  const refresh = () => {
    setNonce((n) => n + 1);
    setRefreshed(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    setFeed("loading");
    fetch("/api/refresh").then((r) => r.json()).then(() => fetch("/api/snapshot")).then((r) => r.json())
      .then((d) => { if (d) { setLive(d); setFeed("live"); } else setFeed("offline"); })
      .catch(() => setFeed("offline"));
  };

  const snap = live || SNAPSHOT;
  const schedule = (live && live.schedule) || [];
  const standings = (live && live.standings) || [];

  const liveMatch = liveGames.find((g) => (g.a === teamH && g.b === teamA) || (g.a === teamA && g.b === teamH));
  const liveModel = useMemo(() => {
    if (!liveMatch) return null;
    const flipped = liveMatch.a === teamA;
    const curH = flipped ? liveMatch.bScore : liveMatch.aScore;
    const curA = flipped ? liveMatch.aScore : liveMatch.bScore;
    const inningsDone = liveMatch.inning || 1;
    const secsSinceSync = syncedAt ? (Date.now() - syncedAt) / 1000 : 0;
    const inningsPlayed = Math.min(9, inningsDone - 1 + secsSinceSync / 720); // ~12 min/inning est.
    const fracLeft = Math.max(0.03, (9 - inningsPlayed) / 9);
    const rlH = Math.max(0.15, lH * fracLeft), rlA = Math.max(0.15, lA * fracLeft);
    const rGrid = buildGrid(rlH, rlA);
    const liveGrid = [];
    for (let i = 0; i <= MAXR; i++) { liveGrid[i] = []; for (let j = 0; j <= MAXR; j++) liveGrid[i][j] = 0; }
    for (let i = 0; i <= MAXR; i++) for (let j = 0; j <= MAXR; j++) {
      const fi = curH + i, fj = curA + j;
      if (fi <= MAXR && fj <= MAXR) liveGrid[fi][fj] += rGrid[i][j];
    }
    const liveS = summarize(liveGrid);
    return { curH, curA, liveGrid, liveS, remH: rlH, remA: rlA, clock: liveMatch.clock || `inning ${Math.ceil(inningsPlayed)}` };
    // eslint-disable-next-line
  }, [liveMatch, lH, lA, tick]);

  const activeGrid = liveMatch ? liveModel.liveGrid : grid;
  const activeS = liveMatch ? liveModel.liveS : s;
  const xgH = liveMatch ? liveModel.remH : lH;
  const xgA = liveMatch ? liveModel.remA : lA;

  const hittersH = (HITTERS[teamH] || []).map(([n, sh]) => ({ n, p: anytime(xgH, sh) })).sort((a, b) => b.p - a.p);
  const hittersA = (HITTERS[teamA] || []).map(([n, sh]) => ({ n, p: anytime(xgA, sh) })).sort((a, b) => b.p - a.p);
  const playersPool = [
    ...(HITTERS[teamH] || []).map(([n, sh]) => ({ n, team: teamH, tag: "H", xg: xgH, share: sh })),
    ...(HITTERS[teamA] || []).map(([n, sh]) => ({ n, team: teamA, tag: "A", xg: xgA, share: sh })),
  ];
  const selPlayer = playersPool.find((p) => p.n === player) || playersPool[0];

  const kLambda = 5.8 + (H.rating - 1500) / 300; // rough proxy, see note in UI

  function resolveBet() {
    switch (bet) {
      case "mlH": return { p: activeS.pH, title: `${H.name} moneyline` };
      case "mlA": return { p: activeS.pA, title: `${A.name} moneyline` };
      case "rlH": return { p: activeS.runline(1.5, "H"), title: `${H.name} -1.5 (run line)` };
      case "rlA": return { p: activeS.runline(1.5, "A"), title: `${A.name} +1.5 (run line)` };
      case "exact": return { p: (activeGrid[si] && activeGrid[si][sj]) || 0, title: `Exact score ${H.name} ${si}-${sj} ${A.name}` };
      case "ou": { const o = overFrom(activeS.tot, ouLine); return { p: ouSide === "over" ? o : 1 - o, title: `${ouSide === "over" ? "Over" : "Under"} ${ouLine} total runs` }; }
      case "tt": { const arr = ttTeam === "H" ? activeS.margH : activeS.margA; const tn = ttTeam === "H" ? H.name : A.name; return { p: overFrom(arr, ttLine), title: `${tn} over ${ttLine} runs` }; }
      case "hr": { const xg = selPlayer.tag === "H" ? xgH : xgA; return { p: anytime(xg, selPlayer.share), title: `${selPlayer.n} to hit a home run${liveMatch ? " (rest of game)" : ""}` }; }
      case "hit2": { const xg = selPlayer.tag === "H" ? xgH : xgA; const mu = xg * selPlayer.share * 2.2; return { p: brace(mu), title: `${selPlayer.n} to record 2+ hits${liveMatch ? " (rest of game)" : ""}`, approx: true }; }
      case "k": { const o = 1 - (() => { let s2 = 0; for (let k = 0; k <= Math.floor(kLine); k++) s2 += poisson(k, kLambda); return s2; })(); return { p: kSide === "over" ? o : 1 - o, title: `${H.name} SP ${kSide === "over" ? "Over" : "Under"} ${kLine} strikeouts`, approx: true }; }
      default: return { p: 0, title: "" };
    }
  }
  const R = resolveBet();
  const risk = 1 - R.p;
  const band = R.p >= 0.65 ? { l: "Safe", c: MINT } : R.p >= 0.40 ? { l: "Moderate", c: AMBER } : { l: "High risk", c: CORAL };
  const autoBetOdds = (() => {
    if (!mktAuto) return null;
    if (bet === "mlH") return mktAuto.h;
    if (bet === "mlA") return mktAuto.a;
    return null;
  })();
  const bImp = impliedProb(autoBetOdds);
  const bEdge = bImp == null ? null : R.p - bImp;
  const bProfit = autoBetOdds ? (parseFloat(autoBetOdds) >= 0 ? parseFloat(autoBetOdds) / 100 : 100 / -parseFloat(autoBetOdds)) : null;
  const bEV = bProfit == null ? null : R.p * bProfit - (1 - R.p);

  const h2h = live && live.h2h && live.h2h[[teamH, teamA].sort().join("|")];
  const maxCell = s.peak.p;

  const css = `
  @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
  .mlb *{box-sizing:border-box;margin:0;padding:0}
  .mlb{--bg:#0B1E24;--surf:#122C33;--surf2:#183840;--line:#22505a;--ink:#EAF2EE;--dim:#8FB0AE;
    --mint:${MINT};--coral:${CORAL};--amber:${AMBER};background:var(--bg);color:var(--ink);
    min-height:100vh;font-family:'Space Grotesk',system-ui,sans-serif;padding:22px 14px 60px;
    background-image:radial-gradient(circle at 50% -8%,#12333a 0%,var(--bg) 46%)}
  .wrap{max-width:1180px;margin:0 auto}
  .eyebrow{font-family:'Space Mono',monospace;font-size:11px;letter-spacing:.28em;color:var(--mint);text-transform:uppercase;margin-bottom:8px}
  .title{font-family:'Bricolage Grotesque',sans-serif;font-weight:800;font-size:clamp(32px,8.5vw,54px);line-height:.92;letter-spacing:-.02em}
  .layout{display:grid;grid-template-columns:1fr 360px;gap:20px;align-items:start;margin-top:20px}
  .main{min-width:0}
  .side{position:sticky;top:20px;min-width:0}
  .livesticky{position:sticky;top:20px;z-index:5}
  @media(max-width:980px){.layout{grid-template-columns:1fr}.side{position:static}.livesticky{position:relative;top:0}}
  .card{background:var(--surf);border:1px solid var(--line);border-radius:16px;padding:18px;margin-top:20px}
  .snaphead{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px}
  .snaphead h3{font-family:'Space Mono';font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--amber);font-weight:700}
  .refresh{background:var(--mint);color:#08181c;border:none;border-radius:9px;padding:9px 14px;font-family:'Space Grotesk';font-weight:700;font-size:13px;cursor:pointer}
  .feedtag{font-family:'Space Mono';font-size:10px;letter-spacing:.1em;padding:3px 8px;border-radius:999px;border:1px solid var(--line)}
  .subtabs{display:flex;gap:6px;margin:14px 0 4px;flex-wrap:wrap}
  .subtabs button{background:var(--surf2);border:1px solid var(--line);color:var(--dim);border-radius:8px;padding:7px 13px;font-family:'Space Grotesk';font-weight:600;font-size:12.5px;cursor:pointer}
  .subtabs button.on{background:var(--line);color:var(--ink)}
  .fxrow{display:flex;align-items:center;gap:10px;padding:11px 10px;border:1px solid var(--line);border-radius:11px;margin-bottom:8px;cursor:pointer;background:var(--surf2)}
  .fxrow:hover{border-color:var(--mint)}
  .fxrow .when{font-family:'Space Mono';font-size:11px;color:var(--dim);width:74px;flex-shrink:0;line-height:1.4}
  .fxrow .match{flex:1;font-weight:600;font-size:14px}
  .fxrow .place{font-family:'Space Mono';font-size:11px;color:var(--dim);text-align:right;line-height:1.4}
  .fxrow .go{font-family:'Space Mono';font-size:11px;color:var(--mint)}
  .setup{display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:end}
  .fld label{display:block;font-family:'Space Mono',monospace;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim);margin-bottom:6px}
  select{width:100%;background:var(--surf2);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:12px 10px;font-family:'Space Grotesk';font-size:15px;font-weight:600;-webkit-appearance:none;appearance:none;cursor:pointer}
  .vs{font-family:'Bricolage Grotesque';font-weight:800;color:var(--dim);font-size:18px;padding-bottom:11px}
  .autotag{font-family:'Space Mono';font-size:12px;color:var(--dim);background:var(--surf2);border:1px solid var(--line);border-radius:999px;padding:8px 13px}
  .bar{display:flex;height:34px;border-radius:9px;overflow:hidden;border:1px solid var(--line)}
  .bar span{display:flex;align-items:center;justify-content:center;font-family:'Space Mono';font-size:12px;font-weight:700;color:#08181c;min-width:0;transition:width .6s cubic-bezier(.4,0,.2,1)}
  .barlabels{display:flex;justify-content:space-between;margin-top:7px;font-family:'Space Mono';font-size:11px;color:var(--dim)}
  .xgrow{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:20px;flex-wrap:wrap}
  .xg{text-align:center}
  .xg .n{font-family:'Bricolage Grotesque';font-weight:800;font-size:38px;line-height:1}
  .xg .l{font-family:'Space Mono';font-size:10px;letter-spacing:.14em;color:var(--dim);text-transform:uppercase;margin-top:4px}
  .dash{color:var(--dim);font-family:'Bricolage Grotesque';font-weight:800;font-size:28px}
  .proj{font-family:'Space Mono';font-size:12px;color:var(--dim);margin-top:2px}
  .tabs{display:flex;gap:6px;margin-top:20px;flex-wrap:wrap}
  .tabs button{background:var(--surf);border:1px solid var(--line);color:var(--dim);border-radius:999px;padding:8px 15px;font-family:'Space Grotesk';font-weight:600;font-size:13px;cursor:pointer}
  .tabs button.on{background:var(--mint);color:#08181c;border-color:var(--mint)}
  .scorers{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .scol h4{font-family:'Space Mono';font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:12px;font-weight:700}
  .prow{display:flex;align-items:center;gap:10px;margin-bottom:11px}
  .prow .nm{width:104px;font-size:13.5px;font-weight:600;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .prow .tk{flex:1;height:9px;background:var(--surf2);border-radius:6px;overflow:hidden}
  .prow .fl{display:block;height:100%;border-radius:6px}
  .prow .pp{font-family:'Space Mono';font-size:12px;width:42px;text-align:right}
  .empty{color:var(--dim);font-size:13px;font-family:'Space Mono';padding:8px 0}
  .note{color:var(--dim);font-size:11px;font-family:'Space Mono';margin-top:10px;line-height:1.55}
  .matrix{display:grid;grid-template-columns:auto repeat(6,1fr);gap:3px}
  .mlab{font-family:'Space Mono';font-size:11px;color:var(--dim);display:flex;align-items:center;justify-content:center;min-height:20px}
  .cell{aspect-ratio:1;border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:'Space Mono';font-size:11px;font-weight:700;color:#dff5ee}
  .cell.peak{outline:2px solid var(--amber);color:#08181c}
  .axname{display:flex;gap:8px;font-size:12px;font-family:'Space Mono';color:var(--dim);margin-top:12px;flex-wrap:wrap}
  .axname b{color:var(--ink)}
  .rf{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .rf label{display:block;font-family:'Space Mono';font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-bottom:5px}
  .rf select,.rf input{width:100%;background:var(--surf2);border:1px solid var(--line);border-radius:8px;color:var(--ink);padding:9px 10px;font-family:'Space Grotesk';font-weight:600;font-size:13px}
  .autoodds{font-family:'Space Mono';font-size:12.5px;color:var(--dim);background:var(--surf2);border:1px solid var(--line);border-radius:8px;padding:9px 10px}
  .riskhead{display:flex;justify-content:space-between;align-items:center;margin-top:18px;flex-wrap:wrap;gap:8px}
  .riskhead .bt{font-size:15px;font-weight:700}
  .chip{font-family:'Space Mono';font-size:12px;font-weight:700;padding:5px 11px;border-radius:999px;color:#08181c}
  .bigp{font-family:'Bricolage Grotesque';font-weight:800;font-size:46px;line-height:1;margin-top:12px}
  .riskbar{height:14px;border-radius:8px;margin-top:14px;overflow:hidden;background:linear-gradient(90deg,#1f4a44,#3a4a2a,#4a2626)}
  .riskbar .rf2{height:100%;border-radius:8px}
  .rmeta{display:flex;justify-content:space-between;font-family:'Space Mono';font-size:11px;color:var(--dim);margin-top:6px}
  .oddsrow{display:flex;gap:20px;flex-wrap:wrap;margin-top:16px}
  .oddsrow .o .n{font-family:'Space Mono';font-weight:700;font-size:17px}
  .oddsrow .o .l{font-family:'Space Mono';font-size:10px;letter-spacing:.1em;color:var(--dim);text-transform:uppercase;margin-top:3px}
  .evbox{margin-top:14px;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--surf2);font-size:13px;line-height:1.5}
  .evbox b{font-family:'Space Mono'}
  .disc{font-family:'Space Mono';font-size:11px;color:var(--dim);line-height:1.6;margin-top:26px;text-align:center;border-top:1px solid var(--line);padding-top:18px}
  .split{display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:stretch}
  .splitcol{border:1px solid var(--line);border-radius:14px;padding:16px;text-align:center;background:var(--surf2)}
  .splitname{font-weight:700;font-size:15px;margin-bottom:8px}
  .splitbig{font-family:'Bricolage Grotesque';font-weight:800;font-size:38px;line-height:1;transition:color .3s}
  .splitlab{font-family:'Space Mono';font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin-top:3px;margin-bottom:12px}
  .splitrow{display:flex;justify-content:space-between;font-size:12.5px;padding:5px 0;border-top:1px solid var(--line)}
  .splitrow span{color:var(--dim)}
  .splitrow b{font-family:'Space Mono';font-weight:700}
  .splitmid{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:10px 6px;min-width:76px}
  .splitdash{font-family:'Bricolage Grotesque';font-weight:800;font-size:24px;color:var(--ink);margin-top:14px}
  @keyframes pulseGlow{0%{box-shadow:0 0 0 0 rgba(255,107,92,.55)}60%{box-shadow:0 0 0 10px rgba(255,107,92,0)}100%{box-shadow:0 0 0 0 rgba(255,107,92,0)}}
  .pulsing{animation:pulseGlow 1.6s ease-in-out infinite}
  @keyframes dotBlink{0%,100%{opacity:1}50%{opacity:.25}}
  .livedot{display:inline-block;width:7px;height:7px;border-radius:50%;background:${CORAL};margin-right:6px;animation:dotBlink 1.1s ease-in-out infinite}
  .standrow{display:flex;justify-content:space-between;font-size:12.5px;padding:5px 0;border-top:1px solid var(--line)}
  .standrow b{font-family:'Space Mono'}
  @media(max-width:560px){.scorers,.rf,.split{grid-template-columns:1fr}.cell{font-size:9px}.prow .nm{width:88px}}`;

  const scorerCol = (team, list, color, abbr) => (
    <div className="scol">
      <h4 style={{ color }}>{abbr} · anytime HR</h4>
      {list.length === 0 ? <div className="empty">No hitter profile loaded for {team} yet.</div>
        : list.map((p, k) => (
          <div className="prow" key={k}>
            <span className="nm">{p.n}</span>
            <span className="tk"><span className="fl" style={{ width: `${p.p * 100}%`, background: color }} /></span>
            <span className="pp" style={{ color }}>{Math.round(p.p * 100)}%</span>
          </div>
        ))}
    </div>
  );

  return (
    <div className="mlb">
      <style>{css}</style>
      <div className="wrap">
        <div className="eyebrow">MLB 2026 · pre-game model</div>
        <h1 className="title">DIAMOND<br />MODEL</h1>

        <div className="layout">
        <div className="main">

        {liveGames.length > 0 && (
          <div className="card livesticky" style={{ borderColor: CORAL }}>
            <div className="snaphead">
              <h3 style={{ color: CORAL }}>● Live now</h3>
              <span className="note" style={{ margin: 0 }}>synced every 10s · live prob. ticks every second</span>
            </div>
            {liveGames.map((g, k) => (
              <div className="fxrow" key={k} onClick={() => loadFixture(g)} style={{ borderColor: CORAL + "55" }}>
                <div className="when" style={{ color: CORAL, fontWeight: 700 }}>{g.clock || "LIVE"}</div>
                <div className="match">
                  {byName(g.a).abbr} {g.aScore} <span style={{ color: "var(--dim)" }}>–</span> {g.bScore} {byName(g.b).abbr}
                  <div className="go">tap for live win prob →</div>
                </div>
                <div className="place">{g.city}<br />{g.stad}</div>
              </div>
            ))}
          </div>
        )}

        <div className="card">
          <h3 style={{ fontFamily: "'Space Mono'", fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: AMBER, marginBottom: 12 }}>Live prediction tracker</h3>
          {(() => {
            const trk = live && live.track;
            if (!trk || trk.total === 0) {
              return <div className="empty" style={{ fontSize: 13.5, lineHeight: 1.65 }}>No graded predictions yet. Every game the model forecasts gets logged automatically and graded once it's final — nobody enters anything by hand.</div>;
            }
            const acc = trk.accuracy;
            const accColor = acc >= 0.6 ? MINT : acc >= 0.45 ? AMBER : CORAL;
            return (<>
              <div style={{ display: "flex", gap: 26, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
                <div><div className="bigp" style={{ color: MINT, fontSize: 34 }}>{trk.correct}</div><div className="note" style={{ margin: 0 }}>correct</div></div>
                <div><div className="bigp" style={{ color: CORAL, fontSize: 34 }}>{trk.incorrect}</div><div className="note" style={{ margin: 0 }}>incorrect</div></div>
                <div><div className="bigp" style={{ color: accColor, fontSize: 34 }}>{Math.round(acc * 100)}%</div><div className="note" style={{ margin: 0 }}>hit rate · {trk.total} graded</div></div>
              </div>
              <div className="riskbar" style={{ marginTop: 4 }}><div className="rf2" style={{ width: `${acc * 100}%`, background: accColor, opacity: 0.85 }} /></div>
              <div className="note" style={{ marginTop: 14, marginBottom: 10 }}>"Correct" = the model's moneyline pick matched the final result. Most recent first.</div>
              {trk.history.slice(0, 6).map((p, k) => (
                <div className="fxrow" key={k} style={{ cursor: "default", borderColor: p.correct ? MINT + "55" : CORAL + "55" }}>
                  <div className="when" style={{ color: p.correct ? MINT : CORAL, fontWeight: 700 }}>{p.correct ? "✓ hit" : "✗ miss"}</div>
                  <div className="match">{byName(p.a).abbr} v {byName(p.b).abbr}<div className="go" style={{ color: "var(--dim)" }}>final {p.finalScore} · picked {p.pick === "A" ? byName(p.a).abbr : byName(p.b).abbr}</div></div>
                  <div className="place">{new Date(p.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
                </div>
              ))}
            </>);
          })()}
        </div>

        <div className="card">
          <div className="setup">
            <div className="fld"><label style={{ color: MINT }}>Home</label>
              <select value={teamH} onChange={(e) => pickH(e.target.value)}>{TEAMS.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</select></div>
            <div className="vs">vs</div>
            <div className="fld"><label style={{ color: CORAL }}>Away</label>
              <select value={teamA} onChange={(e) => pickA(e.target.value)}>{TEAMS.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</select></div>
          </div>
          <div style={{ marginTop: 12 }}>
            <span className="autotag">{H.abbr} hosts {A.abbr}{matchCity ? ` · ${matchCity}` : ""}</span>
          </div>
          <div className="note" style={{ marginTop: 10, marginBottom: 0 }}>
            Ratings pulled from the model's built-in strength table; market odds auto-fill from ESPN's live sportsbook feed when published for this game.
            {mktAuto ? "" : " No market odds published for this matchup yet."}
          </div>
        </div>

        <div className="card">
          {liveModel && (
            <div className="pulsing" style={{ marginBottom: 16, padding: 12, borderRadius: 10, border: `1px solid ${CORAL}`, background: "rgba(255,107,92,0.08)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <span style={{ fontFamily: "'Space Mono'", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: CORAL, fontWeight: 700 }}><span className="livedot" />live · {liveModel.clock}</span>
                <span style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 800, fontSize: 20 }}>{H.abbr} {liveModel.curH} – {liveModel.curA} {A.abbr}</span>
              </div>
              <div className="note" style={{ marginTop: 8, marginBottom: 6 }}>Win probability recalculated from the current score + innings remaining, ticking every second.</div>
              <div className="bar">
                <span style={{ width: `${liveModel.liveS.pH * 100}%`, background: MINT }}>{liveModel.liveS.pH > 0.12 ? p1(liveModel.liveS.pH) : ""}</span>
                <span style={{ width: `${liveModel.liveS.pA * 100}%`, background: CORAL }}>{liveModel.liveS.pA > 0.12 ? p1(liveModel.liveS.pA) : ""}</span>
              </div>
              <div className="barlabels"><span>{H.name} win</span><span>{A.name} win</span></div>
            </div>
          )}
          <div className="bar">
            <span style={{ width: `${s.pH * 100}%`, background: MINT }}>{s.pH > 0.12 ? p1(s.pH) : ""}</span>
            <span style={{ width: `${s.pA * 100}%`, background: CORAL }}>{s.pA > 0.12 ? p1(s.pA) : ""}</span>
          </div>
          <div className="barlabels"><span>{H.name} win{liveMatch ? " (pre-game)" : ""}</span><span>{A.name} win</span></div>
          <div className="xgrow">
            <div className="xg"><div className="n" style={{ color: MINT }}>{lH.toFixed(2)}</div><div className="l">{H.abbr} exp. runs</div></div>
            <div style={{ textAlign: "center" }}><div className="dash">{Math.round(lH)}–{Math.round(lA)}</div><div className="proj">peak {s.peak.i}–{s.peak.j} ({Math.round(s.peak.p * 100)}%)</div></div>
            <div className="xg"><div className="n" style={{ color: CORAL }}>{lA.toFixed(2)}</div><div className="l">{A.abbr} exp. runs</div></div>
          </div>
        </div>

        <div className="tabs">
          <button className={tab === "risk" ? "on" : ""} onClick={() => setTab("risk")}>Risk lab</button>
          <button className={tab === "scorers" ? "on" : ""} onClick={() => setTab("scorers")}>Hitters</button>
          <button className={tab === "matrix" ? "on" : ""} onClick={() => setTab("matrix")}>Score matrix</button>
        </div>

        {tab === "risk" && (
          <div className="card">
            {liveMatch && (
              <div className="pulsing" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, padding: "8px 12px", borderRadius: 9, border: `1px solid ${CORAL}`, background: "rgba(255,107,92,0.08)", flexWrap: "wrap", gap: 6 }}>
                <span style={{ fontFamily: "'Space Mono'", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: CORAL, fontWeight: 700 }}><span className="livedot" />live · {liveModel.clock}</span>
                <span className="note" style={{ margin: 0 }}>every bet below updates off the current score, ticking every second</span>
              </div>
            )}

            <div className={liveMatch ? "pulsing" : ""}>
              <div className="split">
                <div className="splitcol" style={{ borderColor: MINT + "40" }}>
                  <div className="splitname" style={{ color: MINT }}>{H.abbr} (home)</div>
                  <div className="splitbig" style={{ color: MINT }}>{p1(activeS.pH)}</div>
                  <div className="splitlab">win probability</div>
                  <div className="splitrow"><span>Exp. runs</span><b>{xgH.toFixed(2)}</b></div>
                  {hittersH[0] && <div className="splitrow"><span>Top HR threat</span><b>{hittersH[0].n} {Math.round(hittersH[0].p * 100)}%</b></div>}
                </div>
                <div className="splitmid">
                  <div className="splitdash">{liveMatch ? `${liveModel.curH}–${liveModel.curA}` : `${Math.round(lH)}–${Math.round(lA)}`}</div>
                  <div className="splitlab">{liveMatch ? "current score" : "projected score"}</div>
                </div>
                <div className="splitcol" style={{ borderColor: CORAL + "40" }}>
                  <div className="splitname" style={{ color: CORAL }}>{A.abbr} (away)</div>
                  <div className="splitbig" style={{ color: CORAL }}>{p1(activeS.pA)}</div>
                  <div className="splitlab">win probability</div>
                  <div className="splitrow"><span>Exp. runs</span><b>{xgA.toFixed(2)}</b></div>
                  {hittersA[0] && <div className="splitrow"><span>Top HR threat</span><b>{hittersA[0].n} {Math.round(hittersA[0].p * 100)}%</b></div>}
                </div>
              </div>
              {h2h && h2h.played > 0 && (
                <div className="note" style={{ textAlign: "center", marginTop: 8 }}>Recent meetings: {H.abbr} {h2h.aWins} · {A.abbr} {h2h.bWins}</div>
              )}
            </div>

            <div className="note" style={{ marginTop: 16, marginBottom: 14 }}>Educational only. Risk = the model's chance the bet LOSES. Longshots pay more because they lose more often.</div>
            <div className="rf">
              <div><label>Bet type</label>
                <select value={bet} onChange={(e) => setBet(e.target.value)}>
                  <option value="mlH">Moneyline — {H.name}</option>
                  <option value="mlA">Moneyline — {A.name}</option>
                  <option value="rlH">Run line — {H.name} -1.5</option>
                  <option value="rlA">Run line — {A.name} +1.5</option>
                  <option value="exact">Exact final score</option>
                  <option value="ou">Total runs over/under</option>
                  <option value="tt">Team total runs</option>
                  <option value="hr">Player to hit a home run</option>
                  <option value="hit2">Player 2+ hits</option>
                  <option value="k">Starting pitcher strikeouts (rough est.)</option>
                </select>
              </div>
              {bet === "exact" && (<div><label>Score {H.abbr} – {A.abbr}</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <select value={si} onChange={(e) => setSi(+e.target.value)}>{[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>{n}</option>)}</select>
                  <select value={sj} onChange={(e) => setSj(+e.target.value)}>{[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>{n}</option>)}</select>
                </div></div>)}
              {bet === "ou" && (<div><label>Line & side</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <select value={ouLine} onChange={(e) => setOuLine(+e.target.value)}>{[6.5, 7.5, 8.5, 9.5, 10.5].map((n) => <option key={n} value={n}>{n}</option>)}</select>
                  <select value={ouSide} onChange={(e) => setOuSide(e.target.value)}><option value="over">Over</option><option value="under">Under</option></select>
                </div></div>)}
              {bet === "tt" && (<div><label>Team & line</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <select value={ttTeam} onChange={(e) => setTtTeam(e.target.value)}><option value="H">{H.name}</option><option value="A">{A.name}</option></select>
                  <select value={ttLine} onChange={(e) => setTtLine(+e.target.value)}>{[2.5, 3.5, 4.5, 5.5].map((n) => <option key={n} value={n}>{n}</option>)}</select>
                </div></div>)}
              {(bet === "hr" || bet === "hit2") && (<div><label>Player</label>
                <select value={selPlayer ? selPlayer.n : ""} onChange={(e) => setPlayer(e.target.value)}>
                  {playersPool.map((p) => <option key={p.tag + p.n} value={p.n}>{p.n} ({byName(p.team).abbr})</option>)}
                </select></div>)}
              {bet === "k" && (<div><label>Line & side</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <select value={kLine} onChange={(e) => setKLine(+e.target.value)}>{[4.5, 5.5, 6.5, 7.5].map((n) => <option key={n} value={n}>{n}</option>)}</select>
                  <select value={kSide} onChange={(e) => setKSide(e.target.value)}><option value="over">Over</option><option value="under">Under</option></select>
                </div></div>)}
              <div><label>Market odds for this bet</label>
                <div className="autoodds">{autoBetOdds ? `${autoBetOdds} (auto, ESPN)` : "not published for this bet"}</div></div>
            </div>

            <div className="riskhead">
              <div className="bt">{R.title}{R.approx ? " (rough est.)" : ""}</div>
              <div className="chip" style={{ background: band.c }}>{band.l}</div>
            </div>
            <div className="bigp" style={{ color: band.c }}>{p1(R.p)}<span style={{ fontSize: 16, color: "var(--dim)", fontWeight: 400, fontFamily: "'Space Mono'" }}> to hit</span></div>
            <div className="riskbar"><div className="rf2" style={{ width: `${risk * 100}%`, background: band.c, opacity: 0.85 }} /></div>
            <div className="rmeta"><span>0% risk</span><span>risk of losing: {p1(risk)}</span><span>100% risk</span></div>
            <div className="oddsrow">
              <div className="o"><div className="n">{fairAmerican(R.p)}</div><div className="l">fair odds</div></div>
              <div className="o"><div className="n">{(1 / R.p).toFixed(2)}x</div><div className="l">fair payout</div></div>
              {bImp != null && <div className="o"><div className="n" style={{ color: bEdge >= 0 ? MINT : CORAL }}>{bEdge >= 0 ? "+" : ""}{(bEdge * 100).toFixed(1)}%</div><div className="l">edge vs market</div></div>}
              {bEV != null && <div className="o"><div className="n" style={{ color: bEV >= 0 ? MINT : CORAL }}>{bEV >= 0 ? "+" : ""}{(bEV * 100).toFixed(1)}%</div><div className="l">EV per $1</div></div>}
            </div>
            {bet === "k" && <div className="note">Strikeout line is a rough team-strength proxy, not a real per-pitcher K rate — treat it as illustrative until real pitcher stats are wired in.</div>}
            {bImp != null && (<div className="evbox">
              The book prices this at <b>{Math.round(bImp * 100)}%</b>. The model says <b>{p1(R.p)}</b>.{" "}
              {bEdge >= 0 ? `Positive edge — the model thinks it hits more often than the price implies.` : `Negative edge — the price is longer than the model's read, so it grades −EV.`}
            </div>)}
          </div>
        )}

        {tab === "scorers" && (
          <div className="card">
            <div className="scorers">{scorerCol(teamH, hittersH, MINT, H.abbr)}{scorerCol(teamA, hittersA, CORAL, A.abbr)}</div>
            <div className="note">Anytime-HR % = chance a player homers at least once, from their share of the team's {xgH.toFixed(2)}/{xgA.toFixed(2)} expected runs. Form-based approximations.</div>
          </div>
        )}

        {tab === "matrix" && (
          <div className="card">
            <div className="matrix">
              <div className="mlab"></div>
              {[0, 1, 2, 3, 4, 5].map((j) => <div key={"h" + j} className="mlab">{j}</div>)}
              {[0, 1, 2, 3, 4, 5].flatMap((i) => [
                <div key={"r" + i} className="mlab">{i}</div>,
                ...[0, 1, 2, 3, 4, 5].map((j) => {
                  const p = grid[i][j], isPeak = i === s.peak.i && j === s.peak.j;
                  const alpha = Math.min(1, (p / maxCell) * 0.9 + 0.06);
                  return <div key={i + "-" + j} className={"cell" + (isPeak ? " peak" : "")} style={{ background: isPeak ? AMBER : `rgba(79,216,176,${alpha})` }}>{p >= 0.02 ? Math.round(p * 100) : ""}</div>;
                }),
              ])}
            </div>
            <div className="axname"><span>rows <b>{H.abbr}</b> runs</span><span>· cols <b>{A.abbr}</b> runs</span><span>· amber = most likely</span></div>
          </div>
        )}

        </div>

        <aside className="side">
          <div className="card">
            <div className="snaphead">
              <h3>MLB · snapshot {snap.asOf || SNAPSHOT.asOf}</h3>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="feedtag" style={{ color: feed === "live" ? MINT : "var(--dim)", borderColor: feed === "live" ? MINT : "var(--line)" }}>
                  {feed === "live" ? "● live feed" : feed === "loading" ? "…syncing" : "○ snapshot"}
                </span>
                <button className="refresh" onClick={refresh}>↻ Refresh</button>
              </div>
            </div>
            <div className="subtabs">
              {["upcoming", "standings"].map((v) => (
                <button key={v} className={ttab === v ? "on" : ""} onClick={() => setTtab(v)}>{v === "upcoming" ? "Today's slate" : "Standings"}</button>
              ))}
            </div>

            {ttab === "upcoming" && (<>
              <div className="note" style={{ marginTop: 4, marginBottom: 12 }}>Tap any game to load it into the model.</div>
              {schedule.length === 0 && <div className="empty">No games loaded yet — deploy the backend for live data.</div>}
              {schedule.map((fx, k) => (
                <div className="fxrow" key={k} onClick={() => loadFixture(fx)}>
                  <div className="when">{fx.day}<br />{fx.time}</div>
                  <div className="match">{byName(fx.a).abbr} v {byName(fx.b).abbr}<div className="go">tap to model →</div></div>
                  <div className="place">{fx.city}</div>
                </div>
              ))}
              {snap.winner && snap.winner.length > 0 && (<>
                <h5 style={{ marginTop: 16, fontFamily: "'Space Mono'", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--dim)" }}>World Series futures</h5>
                {snap.winner.map((w, k) => (<div className="standrow" key={k}><span>{w[0]}</span><span className="mono">Poly <b>{w[1]}%</b> · Kalshi <b>{w[2]}%</b></span></div>))}
              </>)}
            </>)}

            {ttab === "standings" && (
              <div>
                {standings.length === 0 && <div className="empty">Standings load once the backend is deployed.</div>}
                {standings.map((lg, li) => (
                  <div key={li} style={{ marginBottom: 14 }}>
                    <h5 style={{ fontFamily: "'Space Mono'", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--dim)", marginBottom: 6 }}>{lg.league}</h5>
                    {lg.divisions.map((d, di) => (
                      <div key={di} style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>{d.name}</div>
                        {d.teams.map((t, ti) => (
                          <div className="standrow" key={ti}><span>{t.team}</span><b>{t.wins}-{t.losses} · {t.gb}</b></div>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
        </div>

        <div className="disc">Ratings, hitter shares, and market snapshot are approximate and time-stamped. A model is an edge, not a lock. · 21+. Bet responsibly · 1-800-GAMBLER.</div>
      </div>
    </div>
  );
}
