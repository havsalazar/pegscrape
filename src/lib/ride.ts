/**
 * Ride log parsing for the rounded_fw ESP32-S3 lean-angle logger.
 *
 * CSV header: time_s,date,utc,lat,lon,speed_kmh,lean_deg,accel_g,state,fix,sats
 * One row per 100 ms. GPS fields update at ~1 Hz, so positions are interpolated
 * between GPS samples to get a smooth 10 Hz track.
 */

/** A GPS sample: the first row where a new fix (utc/lat/lon change) appeared. */
export interface GpsSample {
  /** Row index where this fix first appeared. */
  i: number;
  t: number;
  lat: number;
  lon: number;
  /** Bearing towards the next sample, degrees clockwise from north. */
  bearing: number;
  speed: number;
  /** Largest |lean| between this sample and the next one. */
  maxAbsLean: number;
  /** Most extreme longitudinal g between this sample and the next one (signed). */
  peakAccel: number;
  /** True when there is a GPS gap between the previous sample and this one. */
  gapBefore: boolean;
}

export interface Extreme {
  value: number;
  index: number;
}

export interface RideStats {
  duration: number;
  movingTime: number;
  distanceKm: number;
  avgMovingSpeed: number;
  maxSpeed: Extreme;
  /** Most negative lean while moving (left). */
  maxLeanLeft: Extreme;
  /** Most positive lean while moving (right). */
  maxLeanRight: Extreme;
  maxBrake: Extreme;
  maxAccel: Extreme;
  noFixPct: number;
  maxSats: number;
}

/** A stretch of actual riding (speed ≥ MOVING_KMH), with short stops merged in. */
export interface Segment {
  /** Seconds since the start of the ride. */
  start: number;
  end: number;
  maxSpeed: number;
}

export interface Ride {
  name: string;
  n: number;
  /** Monotonic seconds since the start of the recording. */
  t: Float64Array;
  lean: Float32Array;
  accel: Float32Array;
  speed: Float32Array;
  /** Interpolated position, NaN where there is no fix. */
  lat: Float64Array;
  lon: Float64Array;
  heading: Float32Array;
  fix: Uint8Array;
  sats: Int16Array;
  /** Estimated UTC epoch ms for each row, NaN when no GPS time was ever received. */
  epochMs: Float64Array;
  /** Running peak lean (while moving) up to each row. */
  peakLeftSoFar: Float32Array;
  peakRightSoFar: Float32Array;
  samples: GpsSample[];
  segments: Segment[];
  stats: RideStats;
  bounds: [[number, number], [number, number]] | null;
  skippedRows: number;
}

/** Rows below this speed are ignored for lean / g statistics (stand, walking pace). */
export const MOVING_KMH = 5;
/** GPS samples further apart than this are treated as a gap, not interpolated across. */
const MAX_GPS_GAP_S = 3.5;

const REQUIRED = ['time_s', 'lat', 'lon', 'speed_kmh', 'lean_deg', 'accel_g', 'fix'] as const;

export class RideParseError extends Error {}

/** Progress callback: fraction 0..1 of the parse. Called every few thousand rows. */
export type ParseProgress = (fraction: number) => void;

export function parseRide(text: string, name = 'ride.csv', onProgress?: ParseProgress): Ride {
  const lines = text.split(/\r?\n/);
  let h = 0;
  while (h < lines.length && lines[h].trim() === '') h++;
  if (h >= lines.length) throw new RideParseError('The file is empty.');

  const header = lines[h].trim().replace(/^﻿/, '').split(',').map((s) => s.trim().toLowerCase());
  const col = (k: string) => header.indexOf(k);
  const missing = REQUIRED.filter((k) => col(k) < 0);
  if (missing.length) {
    throw new RideParseError(
      `This doesn't look like a ride log: missing column(s) ${missing.join(', ')}.`,
    );
  }
  const cT = col('time_s'),
    cDate = col('date'),
    cUtc = col('utc'),
    cLat = col('lat'),
    cLon = col('lon'),
    cSpd = col('speed_kmh'),
    cLean = col('lean_deg'),
    cAcc = col('accel_g'),
    cFix = col('fix'),
    cSats = col('sats');

  const cap = lines.length - h;
  const t = new Float64Array(cap);
  const lean = new Float32Array(cap);
  const accel = new Float32Array(cap);
  const speed = new Float32Array(cap);
  const rawLat = new Float64Array(cap);
  const rawLon = new Float64Array(cap);
  const fix = new Uint8Array(cap);
  const sats = new Int16Array(cap);
  const date: string[] = new Array(cap);
  const utc: string[] = new Array(cap);

  let n = 0;
  let skipped = 0;
  let offset = 0;
  let prevT = -Infinity;

  for (let li = h + 1; li < lines.length; li++) {
    if (onProgress && (li & 4095) === 0) onProgress((li / lines.length) * 0.85);
    const line = lines[li];
    if (line.length === 0) continue;
    const f = line.split(',');
    if (f.length < header.length - 1) {
      skipped++; // truncated row (e.g. power cut mid-write)
      continue;
    }
    const raw = parseFloat(f[cT]);
    if (!Number.isFinite(raw)) {
      skipped++;
      continue;
    }
    // time_s may repeat; if the timer ever jumps backwards a lot, splice it onto the timeline.
    let tv = raw + offset;
    if (tv < prevT - 1) {
      offset = prevT + 0.1 - raw;
      tv = prevT + 0.1;
    }
    tv = Math.max(tv, prevT === -Infinity ? tv : prevT);
    prevT = tv;

    t[n] = tv;
    lean[n] = num(f[cLean]);
    accel[n] = num(f[cAcc]);
    speed[n] = num(f[cSpd]);
    fix[n] = f[cFix]?.trim() === '1' ? 1 : 0;
    rawLat[n] = fix[n] ? numOrNaN(f[cLat]) : NaN;
    rawLon[n] = fix[n] ? numOrNaN(f[cLon]) : NaN;
    sats[n] = cSats >= 0 ? Math.round(num(f[cSats], -1)) : -1;
    date[n] = cDate >= 0 ? (f[cDate] ?? '').trim() : '';
    utc[n] = cUtc >= 0 ? (f[cUtc] ?? '').trim() : '';
    n++;
  }
  if (n < 2) throw new RideParseError('The file has no data rows.');
  onProgress?.(0.88);

  // ---- GPS samples (new fix = utc/lat/lon changed) ----
  const samples: GpsSample[] = [];
  let lastKey = '';
  for (let i = 0; i < n; i++) {
    if (!fix[i] || !Number.isFinite(rawLat[i]) || !Number.isFinite(rawLon[i])) continue;
    const key = `${utc[i]}|${rawLat[i]}|${rawLon[i]}`;
    if (key === lastKey) continue;
    lastKey = key;
    const prev = samples[samples.length - 1];
    samples.push({
      i,
      t: t[i],
      lat: rawLat[i],
      lon: rawLon[i],
      bearing: NaN,
      speed: speed[i],
      maxAbsLean: 0,
      peakAccel: 0,
      gapBefore: !prev || t[i] - prev.t > MAX_GPS_GAP_S || hasNoFixBetween(fix, prev.i, i),
    });
  }

  // Bearings (carry the previous one while stationary so the arrow doesn't spin).
  let lastBearing = NaN;
  for (let k = 0; k < samples.length; k++) {
    const a = samples[k];
    const b = samples[k + 1];
    if (b && !b.gapBefore && haversineM(a.lat, a.lon, b.lat, b.lon) > 1.5) {
      lastBearing = bearingDeg(a.lat, a.lon, b.lat, b.lon);
    }
    a.bearing = lastBearing;
    // Per-segment extremes for map colouring.
    const end = b ? b.i : n;
    let ml = 0,
      pa = 0;
    for (let i = a.i; i < end; i++) {
      const al = Math.abs(lean[i]);
      if (al > ml) ml = al;
      if (Math.abs(accel[i]) > Math.abs(pa)) pa = accel[i];
    }
    a.maxAbsLean = ml;
    a.peakAccel = pa;
  }
  // Fill bearings before the first movement with the first known bearing.
  const firstBearing = samples.find((s) => Number.isFinite(s.bearing))?.bearing ?? 0;
  for (const s of samples) {
    if (!Number.isFinite(s.bearing)) s.bearing = firstBearing;
    else break;
  }

  // ---- Per-row interpolated position, heading, epoch ----
  const lat = new Float64Array(n).fill(NaN);
  const lon = new Float64Array(n).fill(NaN);
  const heading = new Float32Array(n).fill(NaN);
  const epochMs = new Float64Array(n).fill(NaN);
  let k = -1;
  for (let i = 0; i < n; i++) {
    while (k + 1 < samples.length && samples[k + 1].i <= i) k++;
    if (k < 0 || !fix[i]) continue;
    const a = samples[k];
    const b = samples[k + 1];
    heading[i] = a.bearing;
    if (b && !b.gapBefore && b.t > a.t) {
      const u = Math.min(1, Math.max(0, (t[i] - a.t) / (b.t - a.t)));
      lat[i] = a.lat + (b.lat - a.lat) * u;
      lon[i] = a.lon + (b.lon - a.lon) * u;
    } else {
      lat[i] = a.lat;
      lon[i] = a.lon;
    }
  }

  // Epoch: anchor on GPS sample times, extrapolate with the ESP32 timer.
  let anchorEpoch = NaN;
  let anchorT = NaN;
  for (const s of samples) {
    const e = parseUtc(date[s.i], utc[s.i]);
    if (Number.isFinite(e)) {
      anchorEpoch = e;
      anchorT = s.t;
      break;
    }
  }
  if (Number.isFinite(anchorEpoch)) {
    k = -1;
    for (let i = 0; i < n; i++) {
      while (k + 1 < samples.length && samples[k + 1].i <= i) {
        k++;
        const e = parseUtc(date[samples[k].i], utc[samples[k].i]);
        if (Number.isFinite(e)) {
          anchorEpoch = e;
          anchorT = samples[k].t;
        }
      }
      epochMs[i] = anchorEpoch + (t[i] - anchorT) * 1000;
    }
  }

  onProgress?.(0.94);
  // ---- Stats ----
  const duration = t[n - 1] - t[0];
  let movingTime = 0;
  let noFix = 0;
  let maxSats = 0;
  const maxSpeed: Extreme = { value: 0, index: 0 };
  const maxLeanLeft: Extreme = { value: 0, index: 0 };
  const maxLeanRight: Extreme = { value: 0, index: 0 };
  const maxBrake: Extreme = { value: 0, index: 0 };
  const maxAccel: Extreme = { value: 0, index: 0 };
  const peakLeftSoFar = new Float32Array(n);
  const peakRightSoFar = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!fix[i]) noFix++;
    if (sats[i] > maxSats) maxSats = sats[i];
    if (speed[i] > maxSpeed.value) set(maxSpeed, speed[i], i);
    const moving = speed[i] >= MOVING_KMH;
    if (moving && i > 0) movingTime += t[i] - t[i - 1];
    if (moving) {
      if (lean[i] < maxLeanLeft.value) set(maxLeanLeft, lean[i], i);
      if (lean[i] > maxLeanRight.value) set(maxLeanRight, lean[i], i);
      if (accel[i] < maxBrake.value) set(maxBrake, accel[i], i);
      if (accel[i] > maxAccel.value) set(maxAccel, accel[i], i);
    }
    peakLeftSoFar[i] = maxLeanLeft.value;
    peakRightSoFar[i] = maxLeanRight.value;
  }

  let distM = 0;
  for (let s = 1; s < samples.length; s++) {
    const a = samples[s - 1];
    const b = samples[s];
    if (b.gapBefore) continue;
    // Skip GPS jitter while standing still.
    if (a.speed < 3 && b.speed < 3) continue;
    distM += haversineM(a.lat, a.lon, b.lat, b.lon);
  }

  let bounds: Ride['bounds'] = null;
  if (samples.length) {
    let s = 90,
      w = 180,
      no = -90,
      e = -180;
    for (const p of samples) {
      s = Math.min(s, p.lat);
      no = Math.max(no, p.lat);
      w = Math.min(w, p.lon);
      e = Math.max(e, p.lon);
    }
    bounds = [
      [s, w],
      [no, e],
    ];
  }

  return {
    name,
    n,
    t: t.slice(0, n),
    lean: lean.slice(0, n),
    accel: accel.slice(0, n),
    speed: speed.slice(0, n),
    lat,
    lon,
    heading,
    fix: fix.slice(0, n),
    sats: sats.slice(0, n),
    epochMs,
    peakLeftSoFar,
    peakRightSoFar,
    samples,
    stats: {
      duration,
      movingTime,
      distanceKm: distM / 1000,
      avgMovingSpeed: movingTime > 0 ? distM / 1000 / (movingTime / 3600) : 0,
      maxSpeed,
      maxLeanLeft,
      maxLeanRight,
      maxBrake,
      maxAccel,
      noFixPct: (noFix / n) * 100,
      maxSats,
    },
    bounds,
    skippedRows: skipped,
    segments: findSegments(t.subarray(0, n), speed.subarray(0, n)),
  };
}

/** Values at an arbitrary playback time, linearly interpolated between 10 Hz rows. */
export interface Frame {
  index: number;
  time: number;
  lean: number;
  accel: number;
  speed: number;
  lat: number;
  lon: number;
  heading: number;
  fix: boolean;
  sats: number;
  epochMs: number;
}

/** Index of the last row with t <= time (clamped to [0, n-1]). */
export function indexAt(ride: Ride, time: number): number {
  const t = ride.t;
  const target = t[0] + time;
  let lo = 0,
    hi = ride.n - 1;
  if (target <= t[0]) return 0;
  if (target >= t[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Playback time (relative to the start) of a row. */
export function timeOf(ride: Ride, index: number): number {
  return ride.t[Math.max(0, Math.min(ride.n - 1, index))] - ride.t[0];
}

export function frameAt(ride: Ride, time: number): Frame {
  const i = indexAt(ride, time);
  const j = Math.min(ride.n - 1, i + 1);
  const t0 = ride.t[i];
  const t1 = ride.t[j];
  const u = t1 > t0 ? Math.min(1, Math.max(0, (ride.t[0] + time - t0) / (t1 - t0))) : 0;
  const lerp = (arr: ArrayLike<number>) => arr[i] + (arr[j] - arr[i]) * u;
  const bothFix = Number.isFinite(ride.lat[i]) && Number.isFinite(ride.lat[j]);
  return {
    index: i,
    time,
    lean: lerp(ride.lean),
    accel: lerp(ride.accel),
    speed: lerp(ride.speed),
    lat: bothFix ? lerp(ride.lat) : ride.lat[i],
    lon: bothFix ? lerp(ride.lon) : ride.lon[i],
    heading: ride.heading[i],
    fix: ride.fix[i] === 1,
    sats: ride.sats[i],
    epochMs: Number.isFinite(ride.epochMs[i]) ? ride.epochMs[i] + u * (t1 - t0) * 1000 : NaN,
  };
}

/** Stops shorter than this (traffic lights, junctions) stay inside a segment. */
const SEGMENT_MERGE_GAP_S = 45;
/** Segments shorter than this are noise (walking the bike, GPS jitter). */
const SEGMENT_MIN_S = 5;
/** A little lead-in/out so a segment starts just before pulling away. */
const SEGMENT_PAD_S = 2;

export function findSegments(t: ArrayLike<number>, speed: ArrayLike<number>): Segment[] {
  const n = t.length;
  if (!n) return [];
  const t0 = t[0];
  const raw: Segment[] = [];
  let cur: Segment | null = null;
  for (let i = 0; i < n; i++) {
    const time = t[i] - t0;
    if (speed[i] >= MOVING_KMH) {
      if (cur && time - cur.end <= SEGMENT_MERGE_GAP_S) {
        cur.end = time;
        cur.maxSpeed = Math.max(cur.maxSpeed, speed[i]);
      } else {
        cur = { start: time, end: time, maxSpeed: speed[i] };
        raw.push(cur);
      }
    }
  }
  const duration = t[n - 1] - t0;
  return raw
    .filter((s) => s.end - s.start >= SEGMENT_MIN_S)
    .map((s) => ({ ...s, start: Math.max(0, s.start - SEGMENT_PAD_S), end: Math.min(duration, s.end + SEGMENT_PAD_S) }));
}

// ---------------------------------------------------------------------------

function set(e: Extreme, value: number, index: number) {
  e.value = value;
  e.index = index;
}

function num(s: string | undefined, fallback = 0): number {
  if (s === undefined) return fallback;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : fallback;
}

function numOrNaN(s: string | undefined): number {
  if (s === undefined || s.trim() === '') return NaN;
  return parseFloat(s);
}

function hasNoFixBetween(fix: Uint8Array, a: number, b: number): boolean {
  for (let i = a + 1; i < b; i++) if (!fix[i]) return true;
  return false;
}

function parseUtc(date: string, utc: string): number {
  if (!date || !utc) return NaN;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const u = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(utc);
  if (!d || !u) return NaN;
  const sec = parseFloat(u[3]);
  return Date.UTC(+d[1], +d[2] - 1, +d[3], +u[1], +u[2], Math.floor(sec), Math.round((sec % 1) * 1000));
}

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x =
    Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
    Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
