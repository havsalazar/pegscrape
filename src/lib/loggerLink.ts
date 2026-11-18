// Bluetooth LE link to the logger: list, download and delete rides.
//
// The protocol runs in Rust (src-tauri/src/logger.rs, which documents it); this file is the
// page's side of it. The Rust side talks to the logger through tauri-plugin-blec (btleplug on
// Windows, the plugin's own backend on Android), so it serves both platforms. Outside the
// Tauri app (a plain browser) there is no Bluetooth.
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';

export interface LoggerFile {
  name: string;
  size: number;
}

export interface LoggerInfo {
  name: string;
  recording: boolean;
}

export interface DownloadProgress {
  received: number;
  size: number;
  /** Bytes per second, averaged over the download so far. */
  rate: number;
}

export class LoggerError extends Error {}

/** A logger seen while scanning. */
export interface FoundLogger {
  deviceId: string;
  name: string;
  /** Signal strength in dBm, if known. */
  rssi: number | null;
}

/** Our own scan list of nearby loggers: available wherever the app runs (not in a browser). */
export const canScan = isTauri();

export interface RememberedLogger {
  deviceId: string;
  name: string;
}

const REMEMBER_KEY = 'pegscrape.logger';

/** The logger last connected to (connected to directly, without scanning). */
export function rememberedLogger(): RememberedLogger | null {
  if (!canScan) return null;
  try {
    const v = JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? 'null');
    return v && typeof v.deviceId === 'string' ? { deviceId: v.deviceId, name: String(v.name ?? 'Logger') } : null;
  } catch {
    return null;
  }
}

export function rememberLogger(l: RememberedLogger | null) {
  if (!canScan) return;
  try {
    if (l) localStorage.setItem(REMEMBER_KEY, JSON.stringify(l));
    else localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // Not remembering is fine.
  }
}

/** How the Rust side reports errors (logger.rs `Error`). */
interface RustError {
  kind: 'logger' | 'aborted' | 'ble';
  message?: string;
}

/** Call a logger command, turning its error into the errors the UI expects. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new LoggerError('Bluetooth needs the Pegscrape app (Windows or Android).');
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const err = e as RustError | string;
    if (typeof err === 'object' && err && 'kind' in err) {
      if (err.kind === 'aborted') throw new DOMException('Cancelled', 'AbortError');
      if (err.kind === 'logger') throw new LoggerError(err.message ?? 'Logger error');
      throw new Error(err.message ?? 'Bluetooth error');
    }
    throw new Error(String(err));
  }
}

export class LoggerLink {
  private connected = true;

  private constructor(
    readonly deviceId: string,
    readonly name: string,
    private readonly onDisconnect: () => void,
  ) {}

  /**
   * Scan for loggers and report each one (again when its signal changes) to `onFound`.
   * Resolves once scanning runs; call stopScan() to end it.
   */
  static async scan(onFound: (logger: FoundLogger) => void): Promise<void> {
    const ch = new Channel<FoundLogger>();
    ch.onmessage = onFound;
    await call('logger_scan_start', { onFound: ch });
  }

  static async stopScan() {
    await call('logger_scan_stop').catch(() => {});
  }

  /**
   * Connect to a logger. With a target (from scan() or a remembered logger) it goes straight
   * there; without, the app takes the first logger it finds.
   */
  static async connect(
    onDisconnect: () => void,
    target?: { deviceId: string; name: string },
    timeout = 15_000,
  ): Promise<LoggerLink> {
    let link: LoggerLink | null = null;
    const lost = new Channel<null>();
    lost.onmessage = () => link?.lost();
    const c = await call<{ deviceId: string; name: string }>('logger_connect', {
      target: target ?? null,
      timeoutMs: timeout,
      onDisconnect: lost,
    });
    link = new LoggerLink(c.deviceId, c.name, onDisconnect);
    return link;
  }

  /** The link dropped: tell the UI once. */
  private lost() {
    if (!this.connected) return;
    this.connected = false;
    this.onDisconnect();
  }

  get isConnected() {
    return this.connected;
  }

  async disconnect() {
    await call('logger_disconnect').catch(() => {});
    this.lost();
  }

  info(): Promise<LoggerInfo> {
    return call('logger_info');
  }

  list(): Promise<LoggerFile[]> {
    return call('logger_list');
  }

  /** Download one ride. Aborting the signal stops the transfer on the logger too. */
  async download(name: string, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<Blob> {
    const progress = new Channel<DownloadProgress>();
    progress.onmessage = onProgress;
    const onAbort = () => void call('logger_abort').catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const bytes = await call<ArrayBuffer>('logger_download', { name, onProgress: progress });
      return new Blob([bytes], { type: 'text/csv' });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  remove(name: string): Promise<void> {
    return call('logger_remove', { name });
  }
}
