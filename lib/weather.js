/* ================================================================== */
/*  GAME-DAY WEATHER — daily high temperature (°C) and max wind (km/h)  */
/*  at each team's home park, from Open-Meteo (free, no API key).       */
/*                                                                       */
/*  Two sources, merged into one per-team map in Redis:                 */
/*   - archive-api.open-meteo.com: real recorded history back well      */
/*    before 2020 (runs ~5 days behind the present)                     */
/*   - api.open-meteo.com forecast: the recent past + next ~8 days,     */
/*    so upcoming games get a real forecast at prediction time          */
/*                                                                       */
/*  Stored per team as `mlb-weather-<slug>` -> { "YYYY-MM-DD": [t, w] } */
/*  (compact arrays keep 6+ seasons of daily data ~40KB per team).      */
/*  Daily high is a deliberate simplification vs. hour-of-first-pitch — */
/*  it's one API row per day instead of 24, and day-to-day variation    */
/*  (a 35° scorcher vs. a 10° cold snap) is the signal that matters.    */
/*                                                                       */
/*  Point-in-time honesty: for GRADED games this is recorded history,   */
/*  which is exactly what was knowable pre-game (weather on game day).  */
/*  For upcoming games it's the current forecast — also exactly what a  */
/*  bettor knows pre-game. No leakage either way.                       */
/* ================================================================== */
import { parkInfoFor, PARK_TEAMS } from "./parks.js";

const ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const DAILY_VARS = "temperature_2m_max,wind_speed_10m_max";

// Neutral fallbacks: a mild day. Used when a park has no data for a date
// (weather backfill not run yet, dome, or unknown venue) so the feature
// degrades to "uninformative", never to garbage.
export const NEUTRAL_TEMP = 22;
export const NEUTRAL_WIND = 12;
const DOME_TEMP = 22;
const DOME_WIND = 0;

const slug = (team) => team.toLowerCase().replace(/[^a-z0-9]+/g, "-");
export const weatherKeyFor = (team) => `mlb-weather-${slug(team)}`;
const dayOf = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function parseDaily(data) {
  const out = {};
  const days = data?.daily?.time || [];
  const temps = data?.daily?.temperature_2m_max || [];
  const winds = data?.daily?.wind_speed_10m_max || [];
  for (let i = 0; i < days.length; i++) {
    if (temps[i] == null && winds[i] == null) continue; // archive returns nulls past its horizon
    out[days[i]] = [
      temps[i] == null ? null : Math.round(temps[i] * 10) / 10,
      winds[i] == null ? null : Math.round(winds[i] * 10) / 10,
    ];
  }
  return out;
}

async function fetchDaily(base, params) {
  const qs = new URLSearchParams({ daily: DAILY_VARS, timezone: "auto", ...params });
  const res = await fetch(`${base}?${qs}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  return parseDaily(await res.json());
}

// Full recorded history for one team, era-aware (an A's home game in 2022
// gets Oakland weather; in 2025+, Sacramento). One archive call per era.
export async function fetchWeatherHistory(team, startDate) {
  const eras = [];
  // walk the eras by probing the era boundary dates the parks table knows about
  const first = parkInfoFor(team, startDate);
  const current = parkInfoFor(team, new Date().toISOString());
  const archiveEnd = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (first.park === current.park) {
    eras.push({ era: first, from: startDate, to: archiveEnd });
  } else {
    // one relocation inside the window (A's, Rays): split at 2025-01-01
    eras.push({ era: first, from: startDate, to: "2024-12-31" });
    eras.push({ era: current, from: "2025-01-01", to: archiveEnd });
  }

  const map = {};
  for (const { era, from, to } of eras) {
    if (era.lat == null || from > to) continue;
    const chunk = await fetchDaily(ARCHIVE_BASE, {
      latitude: era.lat, longitude: era.lon, start_date: from, end_date: to,
    });
    Object.assign(map, chunk);
  }
  return map;
}

// Recent past + next ~8 days from the forecast API, for a team's CURRENT park.
export async function fetchWeatherForecast(team) {
  const era = parkInfoFor(team, new Date().toISOString());
  if (era.lat == null) return {};
  return fetchDaily(FORECAST_BASE, {
    latitude: era.lat, longitude: era.lon, past_days: "7", forecast_days: "8",
  });
}

// Merge fresh forecast days into each team's stored weather map. Called from
// /api/refresh for the home teams on the upcoming slate — each team is
// independent and a failure just means that park keeps its older data.
export async function refreshForecasts(redis, teams) {
  const distinct = [...new Set(teams)].filter((t) => PARK_TEAMS.includes(t));
  await Promise.all(distinct.map(async (team) => {
    try {
      const fresh = await fetchWeatherForecast(team);
      if (!Object.keys(fresh).length) return;
      const key = weatherKeyFor(team);
      const existing = (await redis.get(key)) || {};
      await redis.set(key, { ...existing, ...fresh });
    } catch { /* one park failing must never break refresh */ }
  }));
}

// Load every team's weather map in parallel (individual GETs, not one giant
// MGET — keeps each request comfortably under Upstash size limits).
export async function loadWeatherMaps(redis) {
  const values = await Promise.all(PARK_TEAMS.map((t) => redis.get(weatherKeyFor(t)).catch(() => null)));
  const maps = {};
  PARK_TEAMS.forEach((t, i) => { if (values[i]) maps[t] = values[i]; });
  return maps;
}

// Weather features for one game at one park. Dome -> fixed indoor air.
// Retractable roof -> outdoor values clamped to the comfort range teams
// actually keep the roof open in (they close it in extremes).
export function weatherFor(maps, homeTeam, dateISO, park) {
  if (park?.roof === "dome") return { temp: DOME_TEMP, wind: DOME_WIND };
  const row = maps?.[homeTeam]?.[dayOf(dateISO)];
  let temp = row?.[0] ?? NEUTRAL_TEMP;
  let wind = row?.[1] ?? NEUTRAL_WIND;
  if (park?.roof === "retractable") {
    temp = Math.max(16, Math.min(30, temp));
    wind = Math.min(15, wind);
  }
  return { temp, wind };
}
