// Copies the production builds into ./release (git-ignored) with versioned names.
//   node scripts/collect-release.mjs [windows] [android]   (no argument: whichever exist)
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outputs = {
  windows: ['src-tauri/target/release/pegscrape.exe', `Pegscrape_${version}_portable.exe`],
  android: [
    'src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk',
    `Pegscrape_${version}_unsigned.apk`,
  ],
};

const wanted = process.argv.slice(2);
const targets = wanted.length ? wanted : Object.keys(outputs).filter((k) => existsSync(join(root, outputs[k][0])));
mkdirSync(join(root, 'release'), { recursive: true });
for (const t of targets) {
  if (!outputs[t]) throw new Error(`Unknown target: ${t}`);
  const [from, name] = outputs[t];
  const src = join(root, from);
  if (!existsSync(src)) throw new Error(`Not built yet: ${from}`);
  const dest = join(root, 'release', name);
  copyFileSync(src, dest);
  console.log(`release/${name} (${(statSync(dest).size / 1048576).toFixed(1)} MB)`);
}
