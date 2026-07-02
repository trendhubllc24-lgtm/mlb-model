/* ================================================================== */
/*  BALLPARKS — static per-stadium data: run-scoring park factor,       */
/*  coordinates (for the weather lookup), and roof type. Keyed by the   */
/*  exact ESPN team displayName the rest of the app already uses.       */
/*                                                                       */
/*  Park factors are static approximations of multi-year Statcast run   */
/*  factors (1.00 = neutral, Coors ≈ +28% runs, T-Mobile ≈ -8%). They   */
/*  move slowly enough in reality that a static table is honest for a   */
/*  2020-2026 training window — the one thing that must NOT happen is   */
/*  computing them from our own game data, which would leak results.    */
/*                                                                       */
/*  `eras` handles teams that changed home parks inside the training    */
/*  window: the A's (Oakland Coliseum -> Sutter Health Park, Sacramento */
/*  from 2025) and the Rays (Tropicana Field dome -> George M.          */
/*  Steinbrenner Field, outdoors, from 2025 after hurricane damage).    */
/*  Historical weather is fetched per era so a 2022 A's home game gets  */
/*  Oakland weather, not Sacramento's.                                  */
/*                                                                       */
/*  roof: "none" | "retractable" | "dome". Domes get fixed indoor       */
/*  conditions; retractable roofs use outdoor weather but clamped,      */
/*  since teams close the roof in extremes.                             */
/* ================================================================== */

const ERA_SPLIT_2025 = "2025-01-01";

export const PARKS = {
  "Arizona Diamondbacks": { eras: [{ park: "Chase Field", lat: 33.4453, lon: -112.0667, roof: "retractable", factor: 1.05 }] },
  "Atlanta Braves": { eras: [{ park: "Truist Park", lat: 33.8908, lon: -84.4678, roof: "none", factor: 1.03 }] },
  "Baltimore Orioles": { eras: [{ park: "Oriole Park at Camden Yards", lat: 39.2839, lon: -76.6217, roof: "none", factor: 1.00 }] },
  "Boston Red Sox": { eras: [{ park: "Fenway Park", lat: 42.3467, lon: -71.0972, roof: "none", factor: 1.09 }] },
  "Chicago Cubs": { eras: [{ park: "Wrigley Field", lat: 41.9484, lon: -87.6553, roof: "none", factor: 1.01 }] },
  "Chicago White Sox": { eras: [{ park: "Rate Field", lat: 41.8299, lon: -87.6338, roof: "none", factor: 1.02 }] },
  "Cincinnati Reds": { eras: [{ park: "Great American Ball Park", lat: 39.0975, lon: -84.5066, roof: "none", factor: 1.10 }] },
  "Cleveland Guardians": { eras: [{ park: "Progressive Field", lat: 41.4962, lon: -81.6852, roof: "none", factor: 0.97 }] },
  "Colorado Rockies": { eras: [{ park: "Coors Field", lat: 39.7559, lon: -104.9942, roof: "none", factor: 1.28 }] },
  "Detroit Tigers": { eras: [{ park: "Comerica Park", lat: 42.3390, lon: -83.0485, roof: "none", factor: 0.97 }] },
  "Houston Astros": { eras: [{ park: "Daikin Park", lat: 29.7573, lon: -95.3555, roof: "retractable", factor: 0.99 }] },
  "Kansas City Royals": { eras: [{ park: "Kauffman Stadium", lat: 39.0517, lon: -94.4803, roof: "none", factor: 1.06 }] },
  "Los Angeles Angels": { eras: [{ park: "Angel Stadium", lat: 33.8003, lon: -117.8827, roof: "none", factor: 0.99 }] },
  "Los Angeles Dodgers": { eras: [{ park: "Dodger Stadium", lat: 34.0739, lon: -118.2400, roof: "none", factor: 0.98 }] },
  "Miami Marlins": { eras: [{ park: "loanDepot park", lat: 25.7781, lon: -80.2196, roof: "retractable", factor: 0.95 }] },
  "Milwaukee Brewers": { eras: [{ park: "American Family Field", lat: 43.0280, lon: -87.9712, roof: "retractable", factor: 1.00 }] },
  "Minnesota Twins": { eras: [{ park: "Target Field", lat: 44.9817, lon: -93.2776, roof: "none", factor: 0.98 }] },
  "New York Mets": { eras: [{ park: "Citi Field", lat: 40.7571, lon: -73.8458, roof: "none", factor: 0.96 }] },
  "New York Yankees": { eras: [{ park: "Yankee Stadium", lat: 40.8296, lon: -73.9262, roof: "none", factor: 1.04 }] },
  "Athletics": {
    eras: [
      { park: "Oakland Coliseum", lat: 37.7516, lon: -122.2005, roof: "none", factor: 0.96, until: ERA_SPLIT_2025 },
      { park: "Sutter Health Park", lat: 38.5804, lon: -121.5133, roof: "none", factor: 1.02 },
    ],
  },
  "Philadelphia Phillies": { eras: [{ park: "Citizens Bank Park", lat: 39.9061, lon: -75.1665, roof: "none", factor: 1.06 }] },
  "Pittsburgh Pirates": { eras: [{ park: "PNC Park", lat: 40.4469, lon: -80.0057, roof: "none", factor: 0.96 }] },
  "San Diego Padres": { eras: [{ park: "Petco Park", lat: 32.7073, lon: -117.1566, roof: "none", factor: 0.95 }] },
  "San Francisco Giants": { eras: [{ park: "Oracle Park", lat: 37.7786, lon: -122.3893, roof: "none", factor: 0.93 }] },
  "Seattle Mariners": { eras: [{ park: "T-Mobile Park", lat: 47.5914, lon: -122.3325, roof: "retractable", factor: 0.92 }] },
  "St. Louis Cardinals": { eras: [{ park: "Busch Stadium", lat: 38.6226, lon: -90.1928, roof: "none", factor: 0.97 }] },
  "Tampa Bay Rays": {
    eras: [
      { park: "Tropicana Field", lat: 27.7683, lon: -82.6534, roof: "dome", factor: 0.95, until: ERA_SPLIT_2025 },
      { park: "George M. Steinbrenner Field", lat: 27.9803, lon: -82.5067, roof: "none", factor: 1.04 },
    ],
  },
  "Texas Rangers": { eras: [{ park: "Globe Life Field", lat: 32.7473, lon: -97.0847, roof: "retractable", factor: 0.97 }] },
  "Toronto Blue Jays": { eras: [{ park: "Rogers Centre", lat: 43.6414, lon: -79.3894, roof: "retractable", factor: 1.01 }] },
  "Washington Nationals": { eras: [{ park: "Nationals Park", lat: 38.8730, lon: -77.0074, roof: "none", factor: 1.03 }] },
};

export const PARK_TEAMS = Object.keys(PARKS);
const NEUTRAL_PARK = { park: "unknown", lat: null, lon: null, roof: "none", factor: 1.0 };

// Home park in effect for a given team on a given date (handles mid-window
// relocations). Unknown team -> neutral park, so nothing downstream throws.
export function parkInfoFor(team, dateISO) {
  const eras = PARKS[team]?.eras;
  if (!eras) return NEUTRAL_PARK;
  const day = String(dateISO).slice(0, 10);
  for (const era of eras) if (!era.until || day < era.until) return era;
  return eras[eras.length - 1];
}
