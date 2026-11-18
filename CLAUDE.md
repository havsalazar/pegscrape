# CLAUDE.md: Pegscrape (incli-app)

Context for agents working in this folder. The README covers usage and build commands; this file
covers what isn't obvious from the code.

## What this is

Pegscrape views the `RIDExxxx.CSV` ride logs written by an ESP32-S3 motorcycle lean-angle logger
(Waveshare ESP32-S3-Touch-AMOLED-1.75). The app is React 19 + TypeScript + Vite 8 + Tailwind v4 +
shadcn/ui + Leaflet, in a **Tauri 2** shell (`src-tauri/`, Rust) for Windows and Android, app id
`com.incli.app` (kept from the Capacitor app, so Android updates it in place).

Branches: `main` is the previous Electron (Windows) + Capacitor (Android) app, which works
end-to-end on both. `tauri` is the port to Tauri (in progress, see "Tauri port status").

The logger's firmware lives in a **separate repo**, `rounded-inc` (local checkout:
`<FIRMWARE_REPO>`). `rounded_fw/` is the ESP-IDF 6.1 firmware and `roundedui/` its LVGL Pro UI.
The app and the firmware share a Bluetooth protocol, so a change to one side may need the other.

Repository: https://github.com/havsalazar/pegscrape (public). Ride logs in `ingest/` hold real
GPS tracks and are git-ignored; never commit them.

Version: 0.3.0. Bump `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`
together. The Android versionCode is `bundle.android.versionCode` in `tauri.conf.json` (4; the
Capacitor app was at 3, and it must keep growing for in-place updates).

### Local paths (placeholders)

Replace these with the paths on your machine:

| Placeholder | Meaning |
|---|---|
| `<FIRMWARE_REPO>` | Local checkout of the `rounded-inc` firmware repo |
| `<JDK21_HOME>` | A JDK 21 install (e.g. JetBrains Runtime 21) |
| `<ANDROID_SDK>` | The Android SDK root (the folder holding `platform-tools/`) |

## The Bluetooth link to the logger

Files:
- `src-tauri/src/logger.rs`: the protocol, in Rust. Tauri commands `logger_scan_start/stop`,
  `logger_connect/disconnect`, `logger_info`, `logger_list`, `logger_download`, `logger_abort`,
  `logger_remove`. Errors reach the page as `{ kind: 'logger' | 'aborted' | 'ble', message }`.
- `src/lib/loggerLink.ts`: the page's side, the `LoggerLink` class (same API as on `main`, so
  RidesSheet didn't change). Maps `aborted` to an `AbortError`, `logger` to `LoggerError`.
- `src/lib/rideLibrary.ts`: rides saved in the app (IndexedDB `pegscrape-rides`, stores `meta`
  and `data`).
- `src/components/RidesSheet.tsx`: the Rides panel UI.
- `src/lib/keepAlive.ts`: the Android foreground service for screen-off downloads. **A no-op on
  this branch** until it's ported (the Capacitor version is
  `android/app/src/main/java/com/incli/app/{KeepAlivePlugin,TransferService}.java` on `main`).

The BLE library is `tauri-plugin-blec` 0.20 (crate `blec`): btleplug on Windows, its own Kotlin
backend on Android. `logger.rs` uses its Rust API (`tauri_plugin_blec::get_handler()`), not its
JavaScript one. Web Bluetooth isn't available in WebView2 or the Android WebView, so a plain
browser (`npm run dev`) has no Bluetooth. Scanning works on both platforms, so the app always
shows its own list of loggers (`canScan` is true in the app).

Unlike the Capacitor plugin, blec has no "connection priority HIGH" call on Android, which made
downloads several times faster there. If Android downloads are slow, that's the first suspect.

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

The app uses GETZ when `proto >= 2`, and plain GET otherwise. Commands run one at a time (a
mutex in `logger.rs` is held for the whole command) with a 10 s idle timeout; a failed write is
retried once. ABORT is written without waiting for that mutex.

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

### Verified state on `main` (Electron + Capacitor, 2026-11-14)

- Windows (Electron) and Android (Galaxy SM-S948B): a 3.4 MB ride downloads in about 6 s
  compressed, also with the phone's screen off, with no drops.
- The end-to-end flows work: connect, list, download, save, open, delete the saved copy, cancel,
  resume.
- **Never tested against real hardware: deleting a ride on the logger (`DEL`)** from the app.
  Test it with a small throwaway ride before relying on it.

## Tauri port status (2026-11-18)

Done and checked on Windows: `cargo clippy` is clean, `npm run typecheck`, `npm test` and
`npm run app:build` pass (an NSIS installer of about 3 MB).

Tested against the logger (Pegscrape-1474) on Windows, release build:
- Scan finds it; connect in about 2.3 s (1.2 s to the remembered logger); INFO and LS work.
- GETZ download of the 3.4 MB RIDE0005.CSV in 5.7 s (about 620 KB/s, same as Electron), SHA-256
  identical to the file on the card.
- Cancel: ABORT ends the download within about 130 ms with `aborted`; the link keeps working.
- Disconnect: the page is told, later commands fail with "Not connected to the logger."
- Through the Rides panel: connect from the scan list, download with live progress, the ride
  appears under "Saved in this app" and opens (map, timeline, stats), disconnect, reconnect.
- **Not tested: DEL** (deleting a ride on the logger), same as on `main`.

To do:
1. Test DEL with a throwaway ride.
2. Android: install the NDK and the Rust Android targets, `npm run android:init`, rerun
   `scripts/make-icon.ps1` for the launcher icons, and test on the phone (permissions, speed,
   the 40 s drop).
3. Port the screen-off foreground service as a small Tauri mobile plugin and wire up
   `src/lib/keepAlive.ts`.
4. Android release signing (needs the user's keystore).

## Checks

```bash
npm run typecheck     # tsc -b
npm run build
npm test              # parses every CSV in ./ingest and runs sanity checks
cd src-tauri && cargo clippy
npm run app:build     # Windows installer
```

- Rust lives in `~/.cargo/bin`, which a shell opened before rustup was installed doesn't have on
  its PATH.
- To drive the Windows app: start `src-tauri/target/release/pegscrape.exe` with
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`, then use the Chrome
  DevTools Protocol on `http://127.0.0.1:9333/json` and call commands through
  `window.__TAURI_INTERNALS__.invoke`.

- Android builds: Gradle can't run on Android Studio's bundled JBR 25. Use
  `JAVA_HOME=<JDK21_HOME>`.
- The adb binary is `<ANDROID_SDK>/platform-tools/adb.exe`. The user's phone is a Galaxy
  SM-S948B on wireless adb. In Git Bash, prefix adb commands that take device paths with
  `MSYS_NO_PATHCONV=1`.
- To drive the app on the phone: `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`,
  then use the Chrome DevTools Protocol (`Runtime.evaluate` with `userGesture: true`; Bluetooth
  needs a user gesture).

## Release status

- The Windows installer (`src-tauri/target/release/bundle/nsis/`) is **unsigned** (no
  code-signing certificate), so SmartScreen will warn.
- Android has no release signing. A signed release needs the user's keystore; don't invent one.
- Leave no `console.log` debugging in release code.
