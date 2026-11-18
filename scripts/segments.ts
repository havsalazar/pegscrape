// Prints the riding segments detected in each CSV in ./ingest (npm run segments).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRide } from '../src/lib/ride.ts';

const dir = join(process.cwd(), 'ingest');
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.csv'))) {
  const r = parseRide(readFileSync(join(dir, f), 'utf8'), f);
  console.log(`${f}: ${r.segments.length} segment(s) in ${mmss(r.stats.duration)}`);
  for (const s of r.segments) console.log(`  ${mmss(s.start)} – ${mmss(s.end)}  (${mmss(s.end - s.start)}, max ${s.maxSpeed} km/h)`);
}
