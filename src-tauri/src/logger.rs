//! Bluetooth LE link to the logger (rounded_fw/main/ble_sync.c in the firmware repo, whose
//! header comment is the authoritative protocol description).
//!
//! The logger has one service with two characteristics: a text command is written to CMD and
//! the logger answers with notifications on DATA, one frame each: a type byte, then the payload.
//!
//! | Command               | Answer                                                         |
//! |-----------------------|----------------------------------------------------------------|
//! | `INFO`                | `I "proto=2;name=Pegscrape-1234;rec=0"`                        |
//! | `LS`                  | `L "<name>\t<size>"` per ride, newest first, then `E "<count>"`|
//! | `GET <name> [offset]` | `F <u32 size><u32 offset><name>`, `D <bytes>`…, `Z <u32 crc32>`|
//! | `GETZ <name>` (2+)    | As GET from 0, D frames carry a zlib stream, Z is the CRC-32 of the inflated file |
//! | `DEL <name>`          | `K <name>`                                                     |
//! | `ABORT`               | The running GET ends with `A` instead of `Z`                   |
//!
//! Any failure is `X "<reason>"`. Integers are little endian.
//!
//! The logger handles one command at a time and is short on RAM, so commands here run strictly
//! one after another (the `link` mutex is held for the whole command).

use std::io::Write;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use flate2::write::ZlibDecoder;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tauri_plugin_blec::models::{BleDevice, ScanFilter, WriteType};
use tauri_plugin_blec::{Handler, OnDisconnectHandler};
use tokio::sync::{mpsc, Mutex};
use uuid::{uuid, Uuid};

const SERVICE: Uuid = uuid!("5d2a0001-8f4e-4c7a-b1d3-6e9f2a4c8b10");
const CMD: Uuid = uuid!("5d2a0002-8f4e-4c7a-b1d3-6e9f2a4c8b10");
const DATA: Uuid = uuid!("5d2a0003-8f4e-4c7a-b1d3-6e9f2a4c8b10");

/// What the logger advertises as: `Pegscrape-NNNN`.
const NAME_PREFIX: &str = "Pegscrape";

/// No frame for this long while a command runs: the link is gone.
const IDLE_TIMEOUT: Duration = Duration::from_secs(10);
/// How often download progress goes to the page.
const PROGRESS_EVERY: Duration = Duration::from_millis(150);
/// How long a scan runs when connecting without a target.
const PICK_SCAN: Duration = Duration::from_secs(20);

/// An error as the page sees it: `{ kind, message }`.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "lowercase")]
pub enum Error {
    /// Something the rider can act on, worded for them (shown as is).
    Logger(String),
    /// The download was cancelled (ABORT).
    Aborted,
    /// A Bluetooth failure from the platform.
    Ble(String),
}

impl From<tauri_plugin_blec::Error> for Error {
    fn from(e: tauri_plugin_blec::Error) -> Self {
        Error::Ble(e.to_string())
    }
}

type Result<T> = std::result::Result<T, Error>;

fn logger_err(msg: impl Into<String>) -> Error {
    Error::Logger(msg.into())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundLogger {
    device_id: String,
    name: String,
    rssi: Option<i16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    device_id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    device_id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggerInfo {
    name: String,
    recording: bool,
}

#[derive(Serialize)]
pub struct LoggerFile {
    name: String,
    size: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    received: u64,
    size: u64,
    /// Bytes per second, averaged over the download so far.
    rate: f64,
}

enum Frame {
    Data(Vec<u8>),
    Lost,
}

struct Link {
    address: String,
    /// The logger's protocol version, from INFO. 2 adds GETZ.
    proto: u32,
    frames: mpsc::UnboundedReceiver<Frame>,
}

#[derive(Default)]
pub struct Logger {
    /// The connection, locked for the whole of each command.
    link: Mutex<Option<Link>>,
    /// The connected address, readable while a command holds `link` (for ABORT and disconnect).
    address: StdMutex<Option<String>>,
}

/// The BLE handler. On Android the plugin sets it up only once the app is ready, so wait for it.
async fn ble() -> Result<&'static Handler> {
    for _ in 0..50 {
        if let Ok(h) = tauri_plugin_blec::get_handler() {
            return Ok(h);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(logger_err("Bluetooth is not available."))
}

/// The handler, with permissions granted and the adapter on.
async fn ready() -> Result<&'static Handler> {
    let h = ble().await?;
    if !tauri_plugin_blec::check_permissions(true).await? {
        return Err(logger_err("Pegscrape needs the Bluetooth permission to reach the logger."));
    }
    if matches!(h.get_adapter_state().await, tauri_plugin_blec::models::AdapterState::Off) {
        tauri_plugin_blec::enable_bluetooth().await?;
        if cfg!(not(target_os = "android")) {
            return Err(logger_err("Bluetooth is off. Turn it on and try again."));
        }
    }
    Ok(h)
}

fn is_logger(d: &BleDevice) -> bool {
    d.services.contains(&SERVICE) || d.name.starts_with(NAME_PREFIX)
}

fn found(d: &BleDevice) -> FoundLogger {
    FoundLogger {
        device_id: d.address.clone(),
        name: if d.name.is_empty() { "Logger".into() } else { d.name.clone() },
        rssi: d.rssi,
    }
}

fn u32_at(b: &[u8], at: usize) -> Result<u32> {
    b.get(at..at + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or_else(|| logger_err("The logger sent a short frame."))
}

async fn write(h: &Handler, address: &str, cmd: &str) -> Result<()> {
    let send = || h.send_data_to(address, CMD, Some(SERVICE), cmd.as_bytes(), WriteType::WithResponse);
    if send().await.is_ok() {
        return Ok(());
    }
    // A write can fail once while the logger streams notifications (seen on Windows): retry.
    tokio::time::sleep(Duration::from_millis(200)).await;
    send()
        .await
        .map_err(|e| logger_err(format!("Could not send to the logger: {e}")))
}

/// Send `cmd` and feed its frames to `on_frame` until it returns a value or fails.
async fn run<T>(link: &mut Link, cmd: &str, mut on_frame: impl FnMut(u8, &[u8]) -> Result<Option<T>>) -> Result<T> {
    let h = ble().await?;
    // Frames left over from an earlier command that failed or timed out.
    while let Ok(f) = link.frames.try_recv() {
        if let Frame::Lost = f {
            return Err(logger_err("Not connected to the logger."));
        }
    }
    write(h, &link.address, cmd).await?;
    loop {
        let frame = tokio::time::timeout(IDLE_TIMEOUT, link.frames.recv())
            .await
            .map_err(|_| logger_err("The logger stopped answering."))?;
        let bytes = match frame {
            Some(Frame::Data(b)) => b,
            Some(Frame::Lost) | None => return Err(logger_err("The logger disconnected.")),
        };
        let Some((&kind, payload)) = bytes.split_first() else { continue };
        if kind == b'X' {
            return Err(logger_err(String::from_utf8_lossy(payload)));
        }
        if let Some(v) = on_frame(kind, payload)? {
            return Ok(v);
        }
    }
}

impl Logger {
    async fn with_link<T>(&self, f: impl AsyncFnOnce(&mut Link) -> Result<T>) -> Result<T> {
        let mut guard = self.link.lock().await;
        let link = guard.as_mut().ok_or_else(|| logger_err("Not connected to the logger."))?;
        f(link).await
    }
}

/// Scan for loggers, reporting each one (again when its signal changes) to `on_found`.
/// Returns once scanning runs; `logger_scan_stop` ends it, or it stops by itself after `ms`.
#[tauri::command]
pub async fn logger_scan_start(on_found: Channel<FoundLogger>, ms: Option<u64>) -> Result<()> {
    let h = ready().await?;
    let _ = h.stop_scan().await;
    let (tx, mut rx) = mpsc::channel::<Vec<BleDevice>>(4);
    h.discover(Some(tx), ms.unwrap_or(15_000), ScanFilter::None, false).await?;
    tauri::async_runtime::spawn(async move {
        while let Some(devices) = rx.recv().await {
            for d in devices.iter().filter(|d| is_logger(d)) {
                if on_found.send(found(d)).is_err() {
                    return;
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn logger_scan_stop() -> Result<()> {
    if let Ok(h) = tauri_plugin_blec::get_handler() {
        let _ = h.stop_scan().await;
    }
    Ok(())
}

/// Scan until the first logger shows up (connecting without a target).
async fn pick(h: &'static Handler) -> Result<Target> {
    let (tx, mut rx) = mpsc::channel::<Vec<BleDevice>>(4);
    h.discover(Some(tx), PICK_SCAN.as_millis() as u64, ScanFilter::None, false).await?;
    let first = tokio::time::timeout(PICK_SCAN, async {
        while let Some(devices) = rx.recv().await {
            if let Some(d) = devices.iter().find(|d| is_logger(d)) {
                return Some(found(d));
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    let _ = h.stop_scan().await;
    first
        .map(|f| Target { device_id: f.device_id, name: f.name })
        .ok_or_else(|| logger_err("No logger found. Is its Bluetooth on (Settings on the logger)?"))
}

/// Connect to `target`, or without one to the first logger found. `on_disconnect` fires once
/// when the link drops.
#[tauri::command]
pub async fn logger_connect(
    state: tauri::State<'_, Logger>,
    target: Option<Target>,
    timeout_ms: Option<u64>,
    on_disconnect: Channel<()>,
) -> Result<Connected> {
    let h = ready().await?;
    let target = match target {
        Some(t) => t,
        None => pick(h).await?,
    };
    let address = target.device_id.clone();

    // Drop whatever link there was: one logger at a time.
    if let Some(old) = state.link.lock().await.take() {
        let _ = h.disconnect_device(&old.address).await;
    }

    let (tx, rx) = mpsc::unbounded_channel::<Frame>();
    let lost_tx = tx.clone();
    let on_lost = OnDisconnectHandler::from_sync(move || {
        let _ = lost_tx.send(Frame::Lost);
        let _ = on_disconnect.send(());
    });

    let unreachable = || logger_err(format!("Could not reach {}. Is it on, with Bluetooth enabled?", target.name));
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(15_000));
    match tokio::time::timeout(timeout, h.connect(&address, on_lost, false)).await {
        Ok(Ok(_)) => {}
        _ => {
            let _ = h.disconnect_device(&address).await;
            return Err(unreachable());
        }
    }
    let notify = move |data: Vec<u8>| {
        let _ = tx.send(Frame::Data(data));
    };
    if let Err(e) = h.subscribe_to(&address, DATA, Some(SERVICE), notify).await {
        let _ = h.disconnect_device(&address).await;
        return Err(e.into());
    }

    *state.link.lock().await = Some(Link { address: address.clone(), proto: 1, frames: rx });
    *state.address.lock().unwrap() = Some(address.clone());
    Ok(Connected { device_id: address, name: target.name })
}

#[tauri::command]
pub async fn logger_disconnect(state: tauri::State<'_, Logger>) -> Result<()> {
    let address = state.address.lock().unwrap().take();
    if let (Some(address), Ok(h)) = (address, tauri_plugin_blec::get_handler()) {
        let _ = h.disconnect_device(&address).await;
    }
    // Waits for a running command, which the disconnect just ended.
    state.link.lock().await.take();
    Ok(())
}

#[tauri::command]
pub async fn logger_info(state: tauri::State<'_, Logger>) -> Result<LoggerInfo> {
    state
        .with_link(async |link| {
            let text = run(link, "INFO", |kind, p| {
                Ok((kind == b'I').then(|| String::from_utf8_lossy(p).into_owned()))
            })
            .await?;
            let kv = |key: &str| {
                text.split(';')
                    .filter_map(|s| s.split_once('='))
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| v.to_string())
            };
            link.proto = kv("proto").and_then(|v| v.parse().ok()).unwrap_or(1);
            Ok(LoggerInfo {
                name: kv("name").unwrap_or_else(|| "Logger".into()),
                recording: kv("rec").as_deref() == Some("1"),
            })
        })
        .await
}

#[tauri::command]
pub async fn logger_list(state: tauri::State<'_, Logger>) -> Result<Vec<LoggerFile>> {
    state
        .with_link(async |link| {
            let mut files = Vec::new();
            run(link, "LS", |kind, p| {
                match kind {
                    b'L' => {
                        let line = String::from_utf8_lossy(p);
                        let (name, size) = line.split_once('\t').unwrap_or((&line, "0"));
                        files.push(LoggerFile { name: name.to_string(), size: size.trim().parse().unwrap_or(0) });
                    }
                    b'E' => return Ok(Some(())),
                    _ => {}
                }
                Ok(None)
            })
            .await?;
            Ok(files)
        })
        .await
}

/// Download one ride; the page gets the file as an ArrayBuffer. GETZ (zlib, about 12 times
/// fewer notifications) when the logger has it, else plain GET.
#[tauri::command]
pub async fn logger_download(
    state: tauri::State<'_, Logger>,
    name: String,
    on_progress: Channel<Progress>,
) -> Result<Response> {
    let bytes = state
        .with_link(async |link| {
            let compressed = link.proto >= 2;
            let cmd = format!("{} {name}", if compressed { "GETZ" } else { "GET" });
            let mut inflate = ZlibDecoder::new(Vec::new());
            let mut plain = Vec::new();
            let mut size = 0u64;
            let mut started = Instant::now();
            let mut last = Instant::now();
            let progress = |received: u64, size: u64, started: Instant| {
                let secs = started.elapsed().as_secs_f64();
                let rate = if secs > 0.0 { received as f64 / secs } else { 0.0 };
                let _ = on_progress.send(Progress { received, size, rate });
            };
            let damaged = |why: &str| logger_err(format!("{name}: the data arrived damaged ({why}). Try again."));

            run(link, &cmd, |kind, p| {
                match kind {
                    b'F' => {
                        size = u64::from(u32_at(p, 0)?);
                        started = Instant::now();
                        plain.reserve(size as usize);
                        progress(0, size, started);
                    }
                    b'D' => {
                        let received = if compressed {
                            inflate.write_all(p).map_err(|e| damaged(&e.to_string()))?;
                            inflate.get_ref().len()
                        } else {
                            plain.extend_from_slice(p);
                            plain.len()
                        } as u64;
                        if last.elapsed() >= PROGRESS_EVERY {
                            last = Instant::now();
                            progress(received, size, started);
                        }
                    }
                    b'Z' => {
                        let want = u32_at(p, 0)?;
                        let out = if compressed {
                            std::mem::replace(&mut inflate, ZlibDecoder::new(Vec::new()))
                                .finish()
                                .map_err(|e| damaged(&e.to_string()))?
                        } else {
                            std::mem::take(&mut plain)
                        };
                        if out.len() as u64 != size {
                            return Err(logger_err(format!("{name}: got {} of {size} bytes.", out.len())));
                        }
                        if crc32fast::hash(&out) != want {
                            return Err(damaged("CRC"));
                        }
                        progress(size, size, started);
                        return Ok(Some(out));
                    }
                    b'A' => return Err(Error::Aborted),
                    _ => {}
                }
                Ok(None)
            })
            .await
        })
        .await?;
    Ok(Response::new(bytes))
}

/// Stop a running download: it then ends with `A`. Doesn't wait for the command lock.
#[tauri::command]
pub async fn logger_abort(state: tauri::State<'_, Logger>) -> Result<()> {
    let address = state.address.lock().unwrap().clone();
    if let Some(address) = address {
        write(ble().await?, &address, "ABORT").await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn logger_remove(state: tauri::State<'_, Logger>, name: String) -> Result<()> {
    state
        .with_link(async |link| run(link, &format!("DEL {name}"), |kind, _| Ok((kind == b'K').then_some(()))).await)
        .await
}
