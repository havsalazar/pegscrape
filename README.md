# Pegscrape: ride log viewer

Viewer for the `RIDExxxx.CSV` files written by the ESP32-S3 lean-angle logger (`rounded_fw`).
Open a ride to get an interactive map, a playback timeline, a rear view of the bike tilting with the
recorded lean angle, speed, braking/acceleration g, and a ride summary.

It's a React + TypeScript app (Vite, Tailwind v4, shadcn/ui, Leaflet) in a
[Tauri 2](https://v2.tauri.app) shell (`src-tauri/`), for Windows and Android. The Bluetooth link to
the logger runs in Rust.

## Requirements

- **Node.js 22.12+** (Vite 8 refuses older versions).
  With nvm-windows, from PowerShell or cmd: `nvm install 22` then `nvm use 22`.
- **Rust** (stable, via [rustup](https://rustup.rs)) and, on Windows, the MSVC C++ build tools
  (Visual Studio "Desktop development with C++"). WebView2 ships with Windows 11.
- Android only: the Android SDK and **NDK** (Android Studio → SDK Manager → SDK Tools → NDK),
  `ANDROID_HOME` and `NDK_HOME` set, a JDK 17–21 as `JAVA_HOME`, and the Rust targets:
  `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`.

## Develop

```powershell
npm install
npm run app:dev        # the app in its window, with hot reload of the web code
npm run dev            # the web code alone in a browser (no Bluetooth there)
npm test               # parses every CSV in ./ingest and runs sanity checks
```

## Build

### Windows
```powershell
npm run app:build      # src-tauri/target/release/bundle/nsis/Pegscrape_x.y.z_x64-setup.exe
```

### Android
```powershell
npm run android:init   # once: generates src-tauri/gen/android
npm run android:dev    # run on a connected device, with hot reload
npm run android:build  # APK/AAB (signing needs your release keystore)
```

The icons come from `powershell -File scripts/make-icon.ps1` (desktop icons via `tauri icon`, plus
the Android launcher icons once `src-tauri/gen/android` exists).

Map tiles come from Esri. Every tile you view while online is saved on the device (IndexedDB, up to 25,000 tiles, least-recently-used dropped first), so areas you have already looked at work offline. New areas need a connection once. Past the deepest zoom you have saved, offline, a lower-zoom tile is enlarged instead (blurry but readable). The "Offline map" card shows how much is saved and can clear it. Everything else (CSV parsing, track, playback) runs fully offline.

## Using it

- **Rides from the logger** (Bluetooth): **Rides** in the header, then **Connect**. The logger's
  Bluetooth must be on (Settings on the logger) and it must not be recording. Tick rides and
  **Download** them: they're saved in the app (**Saved in this app**) and stay there after being
  deleted from the logger. **Delete** removes the ticked rides from the logger (it warns about
  rides not saved yet); the trash icon next to a saved ride removes the app's copy. A 3.4 MB ride
  takes about 6 s: the logger compresses it on the way.
- **Open**: "Choose CSV file" (or drag a CSV onto the window on desktop). Files are read and parsed in a background worker with a progress ring, so the app stays responsive with large logs.
- **Map**: the track is coloured by speed, lean or g (bottom-right switch). Click the track to jump
  there. *Follow* keeps the rider centred and turns itself off when you pan. Tile style (dark /
  streets / satellite) is in the top-right layer menu.
- **Timeline**: two strips. The thin **overview** is the whole ride (riding segments tinted
  green, the box is the visible window); tap/drag it for coarse jumps. The taller **detail** strip
  shows only that window (30 s … 60 min, or All) for precise scrubbing, and follows the playhead
  while playing. Zoom with −/+, pinch (phone) or the mouse wheel. Both show lean (right up, left
  down), speed (shaded) and braking (red ticks).
- **Riding segments**: stretches at ≥ 5 km/h (stops under 45 s are merged in). ⏮/⏭ next to the
  timeline jump between them; **Skip stops** makes playback jump over the stationary parts.
  `npm run segments` lists them for the files in ./ingest.
- **Ride summary**: click a peak (max lean, top speed, hardest braking…) to jump to that moment.

| Key | Action |
|-----|--------|
| Space / K | Play / pause |
| ← / → | ∓10 s (Shift: ∓60 s) |
| , / . | Step one row (0.1 s) |
| [ / ] | Slower / faster |
| Home / End | Start / end |
| PgUp / PgDn | Previous / next riding segment |
| + / − | Zoom the timeline in / out |
| F | Toggle follow |
| Ctrl+O | Open file |

## Bluetooth link to the logger

`src-tauri/src/logger.rs` talks to `rounded_fw/main/ble_sync.c` (the protocol is described at the
top of both) through [tauri-plugin-blec](https://crates.io/crates/tauri-plugin-blec) (btleplug on
Windows, its own backend on Android). `src/lib/loggerLink.ts` is the page's side: the same
`LoggerLink` API as before, calling the Rust commands.

- Downloads use `GETZ`: the logger sends the file as a zlib stream (10–18× smaller), inflated in
  Rust (`flate2`) and checked against a CRC-32 of the whole file. The page gets the file in one
  piece, and progress through a channel.
- Android: keeping a download going with the screen off (a foreground service) is **not ported
  yet**; `src/lib/keepAlive.ts` does nothing for now.
- Android silently drops notifications over 512 bytes, even with MTU 517: the logger caps them.
- Saved rides live in IndexedDB (`src/lib/rideLibrary.ts`), the CSV and its metadata in separate
  stores so listing doesn't load the files.

## How the data is handled

See `src/lib/ride.ts`.

- `time_s` drives playback. Repeats are allowed; if the timer ever jumps backwards it is spliced
  so the timeline stays monotonic.
- GPS is ~1 Hz, so a *GPS sample* is the first row where `utc/lat/lon` change. Positions are
  linearly interpolated between samples for a smooth 10 Hz track, but never across a gap
  (> 3.5 s apart, or any `fix=0` row in between).
- Rows with `fix=0` have no position. The marker dims there.
- Playback interpolates lean/speed/g between rows, so the bike moves smoothly at 60 fps.
- Peak stats (max lean, braking, accel) only count rows at ≥ 5 km/h, so the side stand and
  walking the bike don't count.
- Lean readings beyond ±90° are shown as-is, but the bike image is clamped at 90°.
- Truncated last rows (power cut mid-write) are skipped and counted in the header.

## Layout

```
src/
  lib/ride.ts            CSV parser, interpolation, stats, frameAt()
  lib/loadRide.ts        runs the parser in a Web Worker (rideLoader.worker.ts) with progress
  lib/tileCache.ts       IndexedDB map tile cache; lib/cachedTileLayer.ts plugs it into Leaflet
  lib/loggerLink.ts      the page's side of the Bluetooth link (calls src-tauri/src/logger.rs)
  lib/rideLibrary.ts     rides saved in the app (IndexedDB)
  lib/keepAlive.ts       Android foreground service around downloads (not ported yet)
  hooks/usePlayback.ts   rAF playback clock (rates 0.5×–32×)
  components/
    RideMap.tsx          Leaflet map, coloured track, rider arrow
    BikeLean.tsx         SVG lean gauge using assets/bike-back-view.png
    Timeline.tsx         canvas overview + scrubber
    Telemetry.tsx        lean readout, speed, g-meter, GPS/clock
    StatsCard.tsx        ride summary with jump-to-peak
    RidesSheet.tsx       the Rides panel: logger over Bluetooth + saved rides
    PlaybackControls.tsx
    ui/                  shadcn/ui components
src-tauri/
  src/lib.rs             Tauri app: plugins and commands
  src/logger.rs          the logger protocol over BLE (scan, connect, INFO, LS, GET/GETZ, DEL, ABORT)
  tauri.conf.json        window, bundle and app id (com.incli.app)
```
