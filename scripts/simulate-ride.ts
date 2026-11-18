// Writes a simulated ride log in the logger's CSV format: one lap of a circuit that starts at
// --start, goes out to --via and comes back to --start by another way.
//
//   node --experimental-strip-types scripts/simulate-ride.ts \
//     --start 3.8935,-76.3694 --via 3.8729,-76.4990 --avg 160 --out ingest/SIM0001.CSV
//
// With --route <file.json> the lap follows that line instead of a drawn circuit (--via is then
// not needed): an OSRM /route response (geometries=geojson), a GeoJSON LineString or Feature, or
// a plain [[lon, lat], ...] array. Road data is straight pieces with sharp vertices, so it is
// smoothed into the line a rider would take.
//
// Options:
//   --max-lean deg   most lean the rider uses (default 58: track; 40-45 is fast street riding)
//   --top km/h       top speed on the straights (default: as fast as the bike goes)
//   --brake g        hardest braking (default 1.0)
//   --accel g        hardest acceleration (default 0.62; power and drag reduce it with speed)
//   --avg km/h       wanted average: the top speed (up to --top) is searched for it. Without
//                    --avg the rider rides at the limits above and the average is what results.
//   --vary 0..1      the cruising speed drifts between (1 - vary) × top and top along the road
//                    (default 0: always top where corners allow)
//   --width          how far a drawn circuit swings out to the sides, as a fraction of
//                    start→via (default 0.1)
//   --seed (sensor noise), --date YYYY-MM-DD, --utc HH:MM:SS.
//
// The physics: lean = atan(v² κ / g) for path curvature κ, so a tighter turn needs more lean.
// Where a turn would need more than --max-lean, the rider brakes for it first (corner speed
// limit), then accelerates out.
//
// The CSV matches rounded_fw: 10 rows per second; GPS (utc, lat, lon, speed) updates once per
// second; lean and longitudinal g every row; state BRK / ACC past ±0.10 g. Right lean is positive.
import fs from 'node:fs';
import path from 'node:path';

const G = 9.80665;
const ROW_S = 0.1;

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback === undefined) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return fallback;
}
const latLon = (s: string): [number, number] => {
  const [a, b] = s.split(',').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`bad lat,lon: ${s}`);
  return [a, b];
};

const start = latLon(arg('start'));
const routeFile = process.argv.includes('--route') ? arg('route') : null;
// With a route the drawn circuit isn't used; a dummy via keeps its maths finite.
const via = routeFile ? ([start[0], start[1] + 0.1] as [number, number]) : latLon(arg('via'));
const avgKmh = process.argv.includes('--avg') ? Number(arg('avg')) : null;
const topMs = Number(arg('top', '400')) / 3.6;
const brakeG = Number(arg('brake', '1.0'));
const accelG = Number(arg('accel', '0.62'));
const vary = Number(arg('vary', '0'));
const maxLean = (Number(arg('max-lean', '58')) * Math.PI) / 180;
const widthFrac = Number(arg('width', '0.1'));
const out = arg('out');
const date = arg('date', new Date().toISOString().slice(0, 10));
const utc0 = arg('utc', '14:00:00');

// Seeded noise, so the same arguments give the same file.
let seed = Number(arg('seed', '1')) >>> 0;
function rand() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

// ---- Local flat frame (metres east/north of the start). Fine over a few tens of km.
const lat0 = (start[0] * Math.PI) / 180;
const M_LAT = 111_132.92 - 559.82 * Math.cos(2 * lat0);
const M_LON = 111_412.84 * Math.cos(lat0);
const toXY = ([la, lo]: [number, number]) => [(lo - start[1]) * M_LON, (la - start[0]) * M_LAT];
const toLatLon = (x: number, y: number) => [start[0] + y / M_LAT, start[1] + x / M_LON];

const [vx, vy] = toXY(via);
const L = Math.hypot(vx, vy);
const ux = vx / L, uy = vy / L; // along start → via
const nx = -uy, ny = ux; // to the left of it
const W = L * widthFrac;

// ---- The circuit, drawn like a real track: corner points joined by straights, each corner
// rounded off with an arc of its own radius (metres). Points are (along, across) fractions of
// start → via (across in units of --width). Start sits on the start/finish straight between the
// last and the first corner; via sits on the straight between the two corners at the far end.
// Out on the left side, back on the right, with tight and fast corners both ways on each leg.
const CORNERS: [number, number, number][] = [
  [0.1, 0.0, 70], // T1 left onto the back
  [0.12, 0.6, 60], // T2 right
  [0.3, 0.65, 250], // T3 fast left
  [0.36, 1.1, 45], // T4 hairpin right
  [0.5, 1.15, 400], // T5 fast right
  [0.56, 0.5, 80], // T6 left
  [0.68, 0.45, 120], // T7 left
  [0.72, 1.2, 55], // T8 right
  [0.88, 1.25, 300], // T9 fast right
  [1.0, 0.5, 90], // T10 right, down past the via point
  [1.0, -0.5, 90], // T11 right, onto the way back
  [0.82, -0.55, 60], // T12 left
  [0.8, -1.2, 70], // T13 right
  [0.66, -1.3, 200], // T14 right
  [0.6, -0.6, 50], // T15 left
  [0.45, -0.5, 150], // T16 left
  [0.4, -1.25, 65], // T17 right
  [0.22, -1.3, 350], // T18 fast right
  [0.16, -0.7, 55], // T19 left
  [0.05, -0.65, 100], // T20 left
  [-0.05, -0.6, 80], // T21 right
  [-0.05, 0.0, 80], // T22 right onto the start/finish straight
];
const P = (a: number, c: number) => [a * L * ux + c * W * nx, a * L * uy + c * W * ny];
const corners = CORNERS.map(([a, c, r]) => ({ p: P(a, c), r }));

/** The lap as a dense polyline: from the start, every straight and corner arc, back to the start. */
function buildLap() {
  const n = corners.length;
  const unit = (from: number[], to: number[]) => {
    const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
    return [(to[0] - from[0]) / d, (to[1] - from[1]) / d, d];
  };
  const arcs = corners.map((c, i) => {
    const prev = corners[(i - 1 + n) % n].p, next = corners[(i + 1) % n].p;
    const [ix, iy, lin] = unit(prev, c.p), [ox, oy, lout] = unit(c.p, next);
    const turn = Math.atan2(ix * oy - iy * ox, ix * ox + iy * oy); // left positive
    let r = c.r;
    // The arc has to fit: its tangent points may use at most half of each straight.
    const maxR = Math.min(lin, lout) / 2 / Math.tan(Math.abs(turn) / 2);
    if (r > maxR) {
      console.warn(`corner ${i + 1}: radius ${r} m doesn't fit, using ${Math.floor(maxR)} m`);
      r = maxR;
    }
    const t = r * Math.tan(Math.abs(turn) / 2);
    const t1 = [c.p[0] - ix * t, c.p[1] - iy * t];
    const side = Math.sign(turn);
    const centre = [t1[0] - iy * r * side, t1[1] + ix * r * side];
    return { t1, centre, r, turn, a0: Math.atan2(t1[1] - centre[1], t1[0] - centre[0]) };
  });
  const out: number[][] = [[0, 0]];
  for (const arc of arcs) {
    out.push(arc.t1); // the straight up to the corner
    const steps = Math.max(8, Math.ceil((Math.abs(arc.turn) * arc.r) / 0.5));
    for (let k = 1; k <= steps; k++) {
      const a = arc.a0 + (arc.turn * k) / steps;
      out.push([arc.centre[0] + arc.r * Math.cos(a), arc.centre[1] + arc.r * Math.sin(a)]);
    }
  }
  out.push([0, 0]); // the last straight, back over the start
  // Straights as dense points too, so resampling below is exact.
  const dense: number[][] = [out[0]];
  for (let i = 1; i < out.length; i++) {
    const [ax, ay] = out[i - 1], [bx, by] = out[i];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.5));
    for (let j = 1; j <= k; j++) dense.push([ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k]);
  }
  return dense;
}
/** A route file as a dense, smoothed polyline in the local frame. */
function loadRoute(file: string) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const coords: [number, number][] =
    j.routes?.[0]?.geometry?.coordinates ?? j.geometry?.coordinates ?? j.coordinates ?? j;
  if (!Array.isArray(coords) || coords.length < 2) throw new Error(`no line in ${file}`);
  const pts = coords.map(([lo, la]) => toXY([la, lo]));
  // Densify to 1 m...
  const d: number[][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let m = 1; m <= k; m++) d.push([ax + ((bx - ax) * m) / k, ay + ((by - ay) * m) / k]);
  }
  // ...then average positions over ±12 m: rounds the vertices off into curves.
  const w = 12;
  return d.map((_, i) => {
    let x = 0, y = 0, c = 0;
    for (let m = Math.max(0, i - w); m <= Math.min(d.length - 1, i + w); m++) (x += d[m][0]), (y += d[m][1]), c++;
    return [x / c, y / c];
  });
}
const dense = routeFile ? loadRoute(routeFile) : buildLap();

// Resample every DS metres along the path.
const DS = 2;
const xs: number[] = [], ys: number[] = [];
{
  let carry = 0;
  xs.push(dense[0][0]);
  ys.push(dense[0][1]);
  for (let i = 1; i < dense.length; i++) {
    const [ax, ay] = dense[i - 1], [bx, by] = dense[i];
    const seg = Math.hypot(bx - ax, by - ay);
    let d = DS - carry;
    while (d <= seg) {
      xs.push(ax + ((bx - ax) * d) / seg);
      ys.push(ay + ((by - ay) * d) / seg);
      d += DS;
    }
    carry = seg - (d - DS);
  }
}
const N = xs.length;
const lapM = (N - 1) * DS;

// Signed curvature (left turn positive) from the heading change over ±H metres, then smoothed:
// the rider rolls in and out of a corner over a few metres rather than at once.
const H = 10;
const h = Math.round(H / DS);
const heading = (i: number) => {
  const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
  return Math.atan2(ys[b] - ys[a], xs[b] - xs[a]);
};
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const kRaw = new Float64Array(N);
for (let i = 0; i < N; i++) {
  const a = Math.max(0, i - h), b = Math.min(N - 1, i + h);
  kRaw[i] = wrap(heading(b) - heading(a)) / ((b - a) * DS || 1);
}
const smooth = (src: Float64Array, metres: number) => {
  const w = Math.round(metres / DS / 2);
  const dst = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(src.length - 1, i + w); j++) (s += src[j]), c++;
    dst[i] = s / c;
  }
  return dst;
};
const kappa = smooth(kRaw, 24);

// ---- Speed profile for a given top speed (m/s): corner limits, then accel / brake passes.
// Traction-limited low down, power-limited (about 650 W/kg) higher up, less air drag: tops out
// near 290 km/h.
const accelAt = (v: number) => Math.min(accelG * G, 650 / Math.max(v, 1)) - 0.0012 * v * v;
const BRAKE = brakeG * G;
// How fast the rider wants to go where nothing forces them slower, as a fraction of the top
// speed: with --vary it drifts smoothly between 1 - vary and 1 over a few kilometres (traffic,
// sight lines, mood), from a sum of slow waves with seeded phases.
const cruise = new Float64Array(N).fill(1);
if (vary > 0) {
  const waves = [1200, 2300, 3700, 6100].map((len) => ({ len, phase: rand() * 2 * Math.PI }));
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (const w of waves) s += Math.sin((2 * Math.PI * i * DS) / w.len + w.phase);
    // s / 4 rarely leaves ±0.55: scale that to ±1, clamp, then map -1..1 to 1 - vary..1.
    const n = Math.max(-1, Math.min(1, s / (waves.length * 0.55)));
    cruise[i] = 1 - (vary * (1 - n)) / 2;
  }
}
/**
 * The speed along the lap with the straights capped at `vTop` (m/s). Corners are taken at the
 * speed where they need --max-lean, so the tighter the turn, the slower and the more lean, up to
 * the limit; turns too wide to need it are taken flat out with less lean. Full braking into the
 * corners, full acceleration out.
 */
function profile(vTop: number) {
  const v = new Float64Array(N);
  for (let i = 0; i < N; i++) v[i] = Math.min(vTop * cruise[i], Math.sqrt((G * Math.tan(maxLean)) / Math.max(Math.abs(kappa[i]), 1e-6)));
  v[0] = 0;
  v[N - 1] = 0;
  for (let i = 1; i < N; i++) v[i] = Math.min(v[i], Math.sqrt(Math.max(0, v[i - 1] ** 2 + 2 * Math.max(accelAt(v[i - 1]), 0) * DS)));
  for (let i = N - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * BRAKE * DS));
  let t = 0;
  for (let i = 1; i < N; i++) t += DS / Math.max((v[i] + v[i - 1]) / 2, 0.5);
  return { v, t, vTop };
}
// At the limits; with --avg, bisect the top speed (up to --top) for the wanted average.
let best = profile(topMs);
if (avgKmh !== null) {
  if (lapM / best.t < avgKmh / 3.6) {
    console.error(
      `At these limits the lap averages ${((lapM / best.t) * 3.6).toFixed(0)} km/h: ` +
        `${avgKmh} km/h needs more lean (--max-lean), a higher --top or a wider circuit (--width).`,
    );
    process.exit(1);
  }
  let lo = 1, hi = topMs;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    const p = profile(mid);
    if (lapM / p.t < avgKmh / 3.6) lo = mid;
    else (hi = mid), (best = p);
  }
}
const v = best.v;

// Time at each path point.
const tAt = new Float64Array(N);
for (let i = 1; i < N; i++) tAt[i] = tAt[i - 1] + DS / Math.max((v[i] + v[i - 1]) / 2, 0.5);
const lapT = tAt[N - 1];

/** Path index (fractional) at time t of the lap. */
function idxAt(t: number) {
  if (t <= 0) return 0;
  if (t >= lapT) return N - 1;
  let a = 0, b = N - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (tAt[m] <= t) a = m;
    else b = m;
  }
  return a + (t - tAt[a]) / (tAt[b] - tAt[a]);
}
const at = (arr: ArrayLike<number>, f: number) => {
  const i = Math.floor(f), j = Math.min(i + 1, arr.length - 1);
  return arr[i] + (arr[j] - arr[i]) * (f - i);
};

// ---- Rows: a short wait on the grid, the lap, a short stop at the end.
const PRE = 12, POST = 10;
const total = PRE + lapT + POST;
const [hh, mm, ss] = utc0.split(':').map(Number);
const utcBase = hh * 3600 + mm * 60 + ss;
const fmtUtc = (sec: number) => {
  const s = Math.floor(sec) % 86400;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}.000`;
};

const lines = ['time_s,date,utc,lat,lon,speed_kmh,lean_deg,accel_g,state,fix,sats'];
let gps = { utc: '', lat: '', lon: '', speed: 0 };
let sats = 34;
let leanPrev = 0;
let maxLeanSeen = 0, maxKmh = 0;
const rows = Math.round(total / ROW_S);
for (let r = 0; r <= rows; r++) {
  const t = r * ROW_S;
  const tl = t - PRE; // time into the lap
  const f = idxAt(tl);
  const speed = tl <= 0 || tl >= lapT ? 0 : at(v, f);

  // GPS: once per second, at the whole second.
  if (r % 10 === 0) {
    const [la, lo] = toLatLon(at(xs, f), at(ys, f));
    if (rand() < 0.2) sats = Math.max(26, Math.min(40, sats + (rand() < 0.5 ? -1 : 1)));
    gps = { utc: fmtUtc(utcBase + t), lat: la.toFixed(6), lon: lo.toFixed(6), speed: Math.round(speed * 3.6) };
  }

  // Lean: what the curvature needs at this speed, eased a little (the bike rolls in and out).
  const need = speed > 0.5 ? -Math.atan((speed * speed * at(kappa, f)) / G) : 0;
  const lean = leanPrev + (need - leanPrev) * 0.6;
  leanPrev = lean;
  const leanDeg = (lean * 180) / Math.PI + gauss() * 0.35 - (speed < 0.5 ? 0.3 : 0);

  // Longitudinal g: the speed change over this row.
  const f2 = idxAt(tl + ROW_S);
  const speed2 = tl + ROW_S <= 0 || tl + ROW_S >= lapT ? 0 : at(v, f2);
  const still = speed < 0.5 && speed2 < 0.5;
  const accel = still ? 0.05 + gauss() * 0.005 : (speed2 - speed) / ROW_S / G + gauss() * 0.02;
  const state = accel <= -0.1 ? 'BRK' : accel >= 0.1 ? 'ACC' : '';

  maxLeanSeen = Math.max(maxLeanSeen, Math.abs(leanDeg));
  maxKmh = Math.max(maxKmh, gps.speed);
  lines.push(
    [t.toFixed(1), date, gps.utc, gps.lat, gps.lon, gps.speed, leanDeg.toFixed(1), accel.toFixed(2), state, 1, sats].join(','),
  );
}

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, lines.join('\n') + '\n');

// Corners: stretches needing more than 15° of lean, with the apex (most lean) of each.
const cornerList: { line: string; left: boolean; apexKmh: number }[] = [];
for (let i = 0; i < N; i++) {
  const leanAt = (j: number) => (Math.atan((v[j] * v[j] * Math.abs(kappa[j])) / G) * 180) / Math.PI;
  if (leanAt(i) < 15) continue;
  let j = i, apex = i;
  while (j < N && leanAt(j) >= 15) {
    if (leanAt(j) > leanAt(apex)) apex = j;
    j++;
  }
  let entry = Math.max(0, i - Math.round(400 / DS));
  for (let k = entry; k < i; k++) if (v[k] > v[entry]) entry = k;
  const side = kappa[apex] > 0 ? 'left ' : 'right';
  cornerList.push({
    line: `    ${side} ${Math.round(v[entry] * 3.6)} → ${Math.round(v[apex] * 3.6)} km/h, ${leanAt(apex).toFixed(0)}°, r ${(1 / Math.abs(kappa[apex])).toFixed(0)} m`,
    left: kappa[apex] > 0,
    apexKmh: v[apex] * 3.6,
  });
  i = j;
}
const lefts = cornerList.filter((c) => c.left).length;
console.log(`  ${cornerList.length} corners over 15° of lean (${lefts} left, ${cornerList.length - lefts} right)`);
// All of them for a short list, the slowest ones for a long one.
const shown = cornerList.length <= 30 ? cornerList : [...cornerList].sort((a, b) => a.apexKmh - b.apexKmh).slice(0, 15);
console.log(`  ${shown.length < cornerList.length ? 'the 15 slowest' : 'each'} (side, entry → apex speed, lean at apex, radius):`);
for (const c of shown) console.log(c.line);
const minR = 1 / Math.max(...Array.from(kappa, Math.abs));
console.log(`${out}: ${lines.length - 1} rows`);
console.log(`  lap ${(lapM / 1000).toFixed(2)} km in ${Math.floor(lapT / 60)}:${String(Math.round(lapT % 60)).padStart(2, '0')}`);
console.log(`  average ${((lapM / lapT) * 3.6).toFixed(1)} km/h, top ${maxKmh} km/h, max lean ${maxLeanSeen.toFixed(1)}°`);
console.log(`  tightest turn radius ${minR.toFixed(0)} m`);
