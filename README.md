# Pegscrape: ride log viewer

Viewer for the `RIDExxxx.CSV` files written by the ESP32-S3 lean-angle logger (`rounded_fw`).
Open a ride to get an interactive map, a playback timeline, a rear view of the bike tilting with the
recorded lean angle, speed, braking/acceleration g, and a ride summary.

It's a React + TypeScript app (Vite, Tailwind v4, shadcn/ui, Leaflet), packaged as:

- **Windows**: Electron (`npm run dist:win` → installer + portable `.exe` in `release/`)
- **Android**: Capacitor (`android/` project, built with Android Studio / Gradle)

## Requirements

- **Node.js 22.12+** (Vite 8, Electron 45 and Capacitor 8 refuse older versions).
  With nvm-windows, from PowerShell or cmd: `nvm install 22` then `nvm use 22`.
- Android only: Android Studio and its SDK. Gradle 8.14 needs a JDK 17–24: if Android Studio's
  bundled JDK is newer (25), point `JAVA_HOME` at a JDK 21 for command-line builds.

## Develop

```powershell
npm install
npm run dev            # browser at http://localhost:5173
npm run electron:dev   # same app inside an Electron window, with hot reload
npm test               # parses every CSV in ./ingest and runs sanity checks
```

## Build

### Windows
```powershell
npm run electron       # build and launch the desktop app
npm run dist:win       # release/Pegscrape Setup x.y.z.exe and a portable exe
```

### Android
```powershell
npm run android:init   # once: build the web app and generate ./android
npm run android:run    # build, sync and run on a connected device/emulator
npm run android:open   # or open the project in Android Studio
```
After changing web code, `npm run android:sync` copies the new build into the Android project.

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

`src/lib/loggerLink.ts` talks to `rounded_fw/main/ble_sync.c` (the protocol is described at the top
of both). It uses `@capacitor-community/bluetooth-le`: native on Android, Web Bluetooth in Electron
(where `electron/main.cjs` picks the first logger found, as Electron has no device chooser).

- Downloads use `GETZ`: the logger sends the file as a zlib stream (10–18× smaller), inflated with
  `DecompressionStream` and checked against a CRC-32 of the whole file.
- Android keeps a download going with the screen off through a foreground service
  (`android/.../TransferService.java`, started from `src/lib/keepAlive.ts`).
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
  lib/loggerLink.ts      Bluetooth link to the logger: list, download (compressed), delete
  lib/rideLibrary.ts     rides saved in the app (IndexedDB)
  lib/keepAlive.ts       Android foreground service around downloads
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
electron/main.cjs        Windows desktop shell
capacitor.config.ts      Android shell
```
