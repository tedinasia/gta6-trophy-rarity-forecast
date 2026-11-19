// gta6-trophy-rarity-forecast-01: a forecaster for Exophase GTA VI PS5 trophy earn
// rates. It reads every case file in the input directory and writes one forecast
// file per case: for each trophy, five quantiles (5, 25, 50, 75, 95%) of its earn
// rate at the case's target.
//
// How it forecasts, per trophy:
//   1. Turn each read into a point (x, y): x = ln(1 + hours since launch),
//      y = logit(rate). The log-time axis is what makes a trophy's climb
//      roughly straight: early on many players hit the easy beats at once,
//      later only the dedicated few keep earning, so the rate's logit grows
//      fast at first and then flattens.
//   2. Find the last refresh. Exophase refreshes its counts on its own clock,
//      and a refresh that adds a flood of new tracked players drags every rate
//      down at once (launch night: 638 -> 3,868 players, every rate lower).
//      A single line fitted across that cliff would read the cliff as a
//      downward trend, so the trend is fitted only on the reads after the
//      last big jump in players_tracked (a jump over 15%); if too few reads
//      survive that cut, the last 24 hours are used instead.
//   3. Fit a least-squares line to the surviving points and read it at the
//      target's x. The slope is shrunk toward zero (n / (n + 3)) and capped,
//      because a short, noisy history must not be allowed to extrapolate a
//      wild climb over a four-day horizon. The move from the last read's
//      logit is capped at 2.5 either way.
//   4. When the history is flat (every read the same rate, as on launch
//      night) there is no trend to fit. Then the median stays at the last
//      read, shifted down half a logit: a flat rate with a growing player
//      base is a rate about to be diluted by the next refresh, and the
//      launch-night refresh is exactly that shape. The spread is widened
//      to cover a refresh-sized move.
//   5. The spread (logit units) combines a random-walk term that grows with
//      the square root of the horizon, the fit's residual scatter, and a
//      floor, so a short-horizon forecast is never overconfident and a
//      noisy fit is never trusted too far.
//
// Nothing here reads the network; everything the program knows is in the
// case file. Output is deterministic: same input, same bytes.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Launch instant; the time axis is hours since here. */
const LAUNCH_MS = Date.parse('2026-11-19T00:00:00Z');

/** A players_tracked jump bigger than this marks a refresh (a new regime). */
const REFRESH_JUMP = 0.15;
/** The trend is fitted on at most this many recent hours of reads. */
const FIT_WINDOW_HOURS = 48;
/** The slope is shrunk by n / (n + this) and capped at this magnitude. */
const SHRINK = 3;
const SLOPE_CAP = 1.0;
/** The median may move at most this far (logit) from the last read. */
const MOVE_CAP = 2.5;
/** Random-walk spread, logit units per square-root day. */
const SIGMA_RW = 0.5;
/** Floor on the spread, logit units. */
const SPREAD_FLOOR = 0.25;
/** When the history is flat: the spread floor and the downward median shift. */
const FLAT_SPREAD_FLOOR = 0.8;
const FLAT_SHIFT = -0.5;

interface Trophy {
  id: number;
}

interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface Case {
  levels: number[];
  horizon_minutes: number;
  target: string;
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct);
  return Math.log(p / (100 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
/** Hours from launch to an ISO timestamp. */
const hoursSinceLaunch = (iso: string): number =>
  Math.max(0, (Date.parse(iso) - LAUNCH_MS) / 3600000);
/** The time axis: ln(1 + hours). */
const timeAxis = (iso: string): number => Math.log1p(hoursSinceLaunch(iso));

/** Least-squares line through points; returns slope, intercept, residual std. */
function fitLine(xs: number[], ys: number[]): { slope: number; intercept: number; resid: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    ss += r * r;
  }
  const resid = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return { slope, intercept, resid };
}

/** Forecast one trophy's five quantiles. */
function forecastTrophy(
  series: Array<{ x: number; y: number; players: number; at: string }>,
  xTarget: number,
  horizonDays: number,
): number[] {
  const last = series[series.length - 1];
  const lastLogit = last.y;

  // Flat history: every read the same rate. No trend exists, so stay near
  // the last read, shifted down for the dilution the next refresh brings,
  // with a spread wide enough to cover a refresh-sized move. A trophy
  // already at the ceiling (100%: every tracked player earned it, and every
  // newcomer earns it at once) does not dilute, so it keeps its median.
  const ys = series.map((p) => p.y);
  const ySpread = Math.max(...ys) - Math.min(...ys);
  if (series.length < 3 || ySpread < 1e-9) {
    const atCeiling = last.y >= logit(99.9);
    const median = atCeiling ? lastLogit : lastLogit + FLAT_SHIFT;
    const sigma = Math.max(FLAT_SPREAD_FLOOR, SIGMA_RW * Math.sqrt(horizonDays));
    return Z.map((z) => round4(clampPct(invLogit(median + z * sigma))));
  }

  // Find the last refresh: the last read whose players_tracked jumped.
  let cut = 0;
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1].players;
    if (prev > 0 && series[i].players / prev - 1 > REFRESH_JUMP) cut = i;
  }
  let window = series.slice(cut);
  // Too few post-refresh reads: fall back to the recent window.
  if (window.length < 3) {
    const cutoffX = timeAxis(last.at) - Math.log1p(FIT_WINDOW_HOURS);
    const recent = series.filter((p) => p.x >= cutoffX);
    window = recent.length >= 3 ? recent : series;
  }

  const xs = window.map((p) => p.x);
  const ws = window.map((p) => p.y);
  const { slope, intercept, resid } = fitLine(xs, ws);
  // Shrink and cap the slope: short noisy histories must not extrapolate wild.
  const shrunk = Math.max(-SLOPE_CAP, Math.min(SLOPE_CAP, slope * (window.length / (window.length + SHRINK))));
  let median = intercept + shrunk * xTarget;
  // Cap how far the median may move from the last read.
  median = Math.max(lastLogit - MOVE_CAP, Math.min(lastLogit + MOVE_CAP, median));
  // Spread: random walk over the horizon, plus the fit's own scatter,
  // plus a floor. Never overconfident.
  const sigma = Math.sqrt(
    SIGMA_RW * SIGMA_RW * horizonDays + resid * resid + SPREAD_FLOOR * SPREAD_FLOOR,
  );
  const qs = Z.map((z) => round4(clampPct(invLogit(median + z * sigma))));
  // Enforce non-decreasing (rounding can in principle tie, never invert).
  for (let i = 1; i < qs.length; i++) if (qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
  return qs;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const horizonDays = c.horizon_minutes / 1440;
  const xTarget = timeAxis(c.target);
  const trophies = c.trophies.map((t, i) => {
    const series: Array<{ x: number; y: number; players: number; at: string }> = [];
    for (const h of c.history) {
      const r = h.rates[i];
      if (r === null || r === undefined) continue;
      series.push({ x: timeAxis(h.at), y: logit(r), players: h.players_tracked, at: h.at });
    }
    if (series.length === 0) {
      // No read ever listed this trophy: fall back to a coin flip.
      const q = Z.map((z) => round4(clampPct(invLogit(z * FLAT_SPREAD_FLOOR))));
      return { id: t.id, q };
    }
    return { id: t.id, q: forecastTrophy(series, xTarget, horizonDays) };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
