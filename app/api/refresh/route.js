import { Redis } from "@upstash/redis";
import {
  getEspnSlate, getEspnH2H, extractLiveGames, getStandings, getPolymarket,
  getKalshi, updateTrackRecord, buildHomeAdvMap, dayKeyOf,
} from "@/lib/sources";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();

export async function GET(req) {
  const authed = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;

  if (!authed) {
    const cached = await redis.get("mlb-snapshot");
    return Response.json({ ok: true, cachedOnly: true, updatedAt: cached?.updatedAt || null });
  }

  try {
    const [slate, winnerPoly, winnerKalshi, standings] = await Promise.all([
      getEspnSlate(),
      getPolymarket("world-series-winner"),      // confirm slug on polymarket.com
      getKalshi("KXMLBWS"),                       // confirm ticker on kalshi.com
      getStandings(),
    ]);

    // Real, ESPN-sourced home-field edge per team (home W% minus road W%),
    // used both for the track-record's Elo update below and shipped in the
    // snapshot so the frontend's client-side model uses it too.
    const homeAdv = buildHomeAdvMap(standings);

    const live = extractLiveGames(slate);
    const track = await updateTrackRecord(redis, slate, homeAdv);

    // Group the upcoming slate by calendar day (ET) so the frontend can show
    // a couple days at a time with a "show more" control instead of one
    // giant flat list.
    const upcoming = slate.filter((g) => g.state === "pre");
    const byDay = {};
    for (const g of upcoming) {
      const key = dayKeyOf(g.date);
      if (!byDay[key]) {
        byDay[key] = {
          date: key,
          label: new Date(g.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" }),
          games: [],
        };
      }
      byDay[key].games.push({
        id: g.id,
        time: new Date(g.date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET",
        a: g.home, b: g.away, city: g.city, stad: g.venue,
        probableA: g.probableHome, probableB: g.probableAway,
        homeML: g.homeML, awayML: g.awayML, overUnder: g.overUnder, spread: g.spread,
      });
    }
    const scheduleDays = Object.keys(byDay).sort().map((k) => byDay[k]);

    const cleanLabel = (s) => (s || "").replace(/[^\p{L}\s]/gu, "").trim().toLowerCase();
    const kByName = {};
    for (const k of winnerKalshi) kByName[cleanLabel(k.label)] = Math.round(k.prob * 100);
    const winner = winnerPoly.slice(0, 6).map((p) => {
      const kMatch = kByName[cleanLabel(p.label)];
      return [p.label, Math.round(p.prob * 100), kMatch ?? "—"];
    });

    // head-to-head: soonest 12 games, fetched in parallel (not sequential —
    // that exact mistake once silently timed out the whole refresh)
    const h2hTargets = upcoming.slice(0, 12);
    const h2hResults = await Promise.all(h2hTargets.map((g) => getEspnH2H(g.id, g.home, g.away)));
    const h2h = {};
    h2hTargets.forEach((g, i) => { h2h[[g.home, g.away].sort().join("|")] = h2hResults[i]; });

    const snapshot = {
      updatedAt: new Date().toISOString(),
      asOf: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" }),
      note: "Auto-updated from ESPN + Polymarket + Kalshi.",
      winner, scheduleDays, standings, homeAdv, h2h, live, track,
      ratings: track.ratings,
    };
    await redis.set("mlb-snapshot", snapshot);
    return Response.json({ ok: true, updatedAt: snapshot.updatedAt });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
