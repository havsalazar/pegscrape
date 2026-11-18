# CLAUDE.md: Pegscrape (incli-app)

Context for agents working in this folder. The README covers usage and build commands; this file
covers what isn't obvious from the code.

## What this is

Pegscrape views the `RIDExxxx.CSV` ride logs written by an ESP32-S3 motorcycle lean-angle logger
(Waveshare ESP32-S3-Touch-AMOLED-1.75). The app is React 19 + TypeScript + Vite 8 + Tailwind v4 +
shadcn/ui + Leaflet. It ships in two shells:

- **Windows**: Electron (`electron/main.cjs`), built with `npm run dist:win`.
- **Android**: Capacitor 8 (`android/`), app id `com.incli.app`.

The logger's firmware lives in a **separate repo**, `rounded-inc` (local checkout:
`<FIRMWARE_REPO>`). `rounded_fw/` is the ESP-IDF 6.1 firmware and `roundedui/` its LVGL Pro UI.
The app and the firmware share a Bluetooth protocol, so a change to one side may need the other.

Repository: https://github.com/havsalazar/pegscrape (public). Ride logs in `ingest/` hold real
GPS tracks and are git-ignored; never commit them.

Version: 0.3.0 (`package.json` and `android/app/build.gradle`: versionName 0.3.0, versionCode 3).
Bump them together.

### Local paths (placeholders)

Replace these with the paths on your machine:

| Placeholder | Meaning |
|---|---|
| `<FIRMWARE_REPO>` | Local checkout of the `rounded-inc` firmware repo |
| `<JDK21_HOME>` | A JDK 21 install (e.g. JetBrains Runtime 21) |
| `<ANDROID_SDK>` | The Android SDK root (the folder holding `platform-tools/`) |

## The Bluetooth link to the logger

Files:
- `src/lib/loggerLink.ts`: the `LoggerLink` class (connect, info, list, download, remove,
  disconnect).
- `src/lib/rideLibrary.ts`: rides saved in the app (IndexedDB `pegscrape-rides`, stores `meta`
  and `data`).
- `src/components/RidesSheet.tsx`: the Rides panel UI.
- `src/lib/keepAlive.ts` + `android/app/src/main/java/com/incli/app/{KeepAlivePlugin,TransferService}.java`:
  an Android foreground service that keeps a download alive with the screen off.
- `electron/main.cjs`: the `select-bluetooth-device` handler (Electron has no device chooser; it
  picks the first device named "Pegscrape…", 20 s timeout).

The library is `@capacitor-community/bluetooth-le` 8.3.0: native on Android, Web Bluetooth in
Electron and the browser. One code path serves both.

### Protocol

The authoritative description is the top of `rounded_fw/main/ble_sync.h` in the firmware repo.
The header comment of `loggerLink.ts` is out of date (it says proto=1 and doesn't list GETZ).

- Service `5d2a0001-8f4e-4c7a-b1d3-6e9f2a4c8b10`.
- CMD `…0002`: write one text command per write.
- DATA `…0003`: notify. Each notification is one frame, a type byte and then the payload.
  Integers are little-endian.
- The logger advertises as `Pegscrape-NNNN` (NNNN = 1000 + MAC % 9000).

| Command | Answer |
|---|---|
| `INFO` | `I "proto=2;name=Pegscrape-1234;rec=0"` |
| `LS` | `L "<name>\t<size>"` per ride, newest first, then `E "<count>"` |
| `GET <name> [offset]` | `F <u32 size><u32 offset><name>`, then `D <bytes>`…, then `Z <u32 crc32>` |
| `GETZ <name>` (proto ≥ 2) | Same as GET from 0, but the D frames carry a zlib stream; Z is the CRC-32 of the **uncompressed** file |
| `DEL <name>` | `K <name>` |
| `ABORT` | The running GET ends with `A` instead of `Z` |

Any failure answers `X "<reason>"`, e.g. `recording: stop it first`, or `low memory` when the
logger can't mount its SD card. RidesSheet maps these to user-facing text.

The app uses GETZ when `proto >= 2` and `DecompressionStream` exists, and plain GET otherwise.
Commands run one at a time with a 10 s idle timeout; a failed write is retried once.

### Hard-won constraints (don't undo these)

- **Android drops notifications over 512 bytes**, silently, even after negotiating MTU 517.
  Windows accepts them, so a test on Windows alone won't show the problem. The firmware caps a
  frame at 512 bytes (`frame_payload_max()` in `ble_sync.c`). The symptom of breaking this is
  "1 KB/s" and stalled downloads on the phone only.
- **The logger must not request PHY or connection-parameter updates.** They collide with the
  phone's own requests and drop the link after exactly 40 s (reason 0x222). Only the data-length
  request is sent.
- **The logger is short on internal RAM** (BLE + LVGL + SD card). Requests that make it buffer
  more, or parallel commands, are a bad idea. The firmware handles one command at a time.
- The logger refuses card access while it's recording; the UI tells the user to stop recording.

### Verified state (2026-11-14)

- Windows (Electron) and Android (Galaxy SM-S948B): a 3.4 MB ride downloads in about 6 s
  compressed, also with the phone's screen off, with no drops.
- The end-to-end flows work: connect, list, download, save, open, delete the saved copy, cancel,
  resume.
- **Never tested against real hardware: deleting a ride on the logger (`DEL`)** from the app.
  Test it with a small throwaway ride before relying on it.

## Checks

```bash
npm run typecheck     # tsc -b
npm run build
npm test              # parses every CSV in ./ingest and runs sanity checks
```

- Electron from a VS Code terminal: VS Code sets `ELECTRON_RUN_AS_NODE`, which makes Electron
  behave like plain Node. Launch it with `env -u ELECTRON_RUN_AS_NODE npx electron .`.
- Android command-line builds: Gradle 8.14 can't run on Android Studio's bundled JBR 25. Use
  `JAVA_HOME=<JDK21_HOME>`, then `cd android && ./gradlew assembleDebug`.
  Run `npm run android:sync` first after any web change.
- The adb binary is `<ANDROID_SDK>/platform-tools/adb.exe`. The user's phone is a Galaxy
  SM-S948B on wireless adb. In Git Bash, prefix adb commands that take device paths with
  `MSYS_NO_PATHCONV=1`.
- To drive the app on the phone: `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`,
  then use the Chrome DevTools Protocol (`Runtime.evaluate` with `userGesture: true`; Bluetooth
  needs a user gesture).
- To see what the native BLE layer receives, temporarily set `loggingBehavior: 'debug'` in
  `capacitor.config.ts` (the release value is `'none'`) and watch logcat for
  "Notifying listeners".

## Release status

- `release/Pegscrape Setup <version>.exe` and `release/Pegscrape <version>.exe` are built but
  **unsigned** (no code-signing certificate), so SmartScreen will warn.
- Android has only a debug build. There's no release keystore or `signingConfigs` in
  `android/app/build.gradle`. A signed release needs the user's keystore; don't invent one.
- Keep `loggingBehavior: 'none'` and leave no `console.log` debugging in release code.
