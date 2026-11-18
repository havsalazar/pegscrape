// Sanity check: parse every CSV in ./ingest and print a summary.
// Run with: npm test   (Node >= 22.6, uses --experimental-strip-types)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRide, frameAt, indexAt, timeOf } from '../src/lib/ride.ts';

const dir = join(process.cwd(), 'ingest');
let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures++;
    console.error('  FAIL', msg);
  }
};

for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.csv'))) {
  const t0 = performance.now();
  const ride = parseRide(readFileSync(join(dir, f), 'utf8'), f);
  const ms = performance.now() - t0;
  const s = ride.stats;
  console.log(`${f}: ${ride.n} rows, ${ride.samples.length} GPS samples, parsed in ${ms.toFixed(0)} ms`);
  console.log(
    `  duration ${(s.duration / 60).toFixed(1)} min, moving ${(s.movingTime / 60).toFixed(1)} min, ` +
      `${s.distanceKm.toFixed(2)} km, max ${s.maxSpeed.value} km/h, avg ${s.avgMovingSpeed.toFixed(1)} km/h`,
  );
  console.log(
    `  lean L ${s.maxLeanLeft.value} R ${s.maxLeanRight.value}, brake ${s.maxBrake.value} g, accel ${s.maxAccel.value} g, ` +
      `no-fix ${s.noFixPct.toFixed(1)}%, skipped ${ride.skippedRows}`,
  );
  console.log(`  start ${new Date(ride.epochMs[0]).toISOString()}  bounds ${JSON.stringify(ride.bounds)}`);

  for (let i = 1; i < ride.n; i++) if (ride.t[i] < ride.t[i - 1]) { assert(false, `t not monotonic at ${i}`); break; }
  for (const i of [0, 1, 1234, ride.n - 1]) assert(indexAt(ride, timeOf(ride, i)) >= i - 1, `indexAt round trip ${i}`);
  const mid = frameAt(ride, s.duration / 2);
  assert(Number.isFinite(mid.lean), 'frame lean finite');
  const fixRows = ride.fix.reduce((a, b) => a + b, 0);
  let latRows = 0;
  for (let i = 0; i < ride.n; i++) if (Number.isFinite(ride.lat[i])) latRows++;
  assert(latRows <= fixRows, 'positions only where fix=1');
  // Interpolated positions should never jump more than ~100 m between 10 Hz rows.
  let maxStep = 0;
  for (let i = 1; i < ride.n; i++) {
    if (!Number.isFinite(ride.lat[i]) || !Number.isFinite(ride.lat[i - 1])) continue;
    const d = Math.hypot((ride.lat[i] - ride.lat[i - 1]) * 111e3, (ride.lon[i] - ride.lon[i - 1]) * 111e3);
    maxStep = Math.max(maxStep, d);
  }
  console.log(`  max step between rows ${maxStep.toFixed(1)} m`);
}

// Edge cases
try { parseRide('foo,bar\n1,2'); assert(false, 'should reject wrong header'); } catch { /* expected */ }
const tiny = parseRide(
  'time_s,date,utc,lat,lon,speed_kmh,lean_deg,accel_g,state,fix,sats\n' +
    '0.0,,,,,0,0,0,,0,-1\n0.1,,,,,0,0,0,,0,-1\n0.2,2026-11-14,00:00:01.000,3.1,-76.1,10,5,0.2,ACC,1,9\n0.2,2026-11-14,00:00:01.000,3.1,-76.1,10,6,0.2,ACC,1,9\n0.3,2026-11-14,00:0',
);
assert(tiny.n === 4 && tiny.skippedRows === 1, `tiny file rows (got n=${tiny.n} skipped=${tiny.skippedRows})`);
assert(Number.isNaN(tiny.lat[0]) && tiny.lat[2] === 3.1, 'no position before first fix');
assert(tiny.t[3] >= tiny.t[2], 'repeated time_s kept monotonic');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
