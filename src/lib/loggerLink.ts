// Bluetooth LE link to the logger (rounded_fw/main/ble_sync.c): list, download and delete rides.
//
// The logger has one service with two characteristics: we write a text command to CMD and it
// answers with notifications on DATA, one frame each: a type byte, then the payload.
//   INFO -> I "proto=1;name=Pegscrape-1234;rec=0"
//   LS   -> L "<name>\t<size>" per ride, newest first, then E "<count>"
//   GET <name> [offset] -> F <u32 size><u32 offset><name>, D <bytes>..., Z <u32 crc32>
//   DEL <name> -> K <name>
//   ABORT -> the running GET ends with A
// Any failure is X "<reason>". Integers are little endian.
//
// @capacitor-community/bluetooth-le is native on Android and uses Web Bluetooth elsewhere
// (Electron: electron/main.cjs picks the device), so this one file serves both.
import { BleClient, ConnectionPriority, numbersToDataView } from '@capacitor-community/bluetooth-le';
import { Capacitor } from '@capacitor/core';

export const LOGGER_SERVICE = '5d2a0001-8f4e-4c7a-b1d3-6e9f2a4c8b10';
const CMD = '5d2a0002-8f4e-4c7a-b1d3-6e9f2a4c8b10';
const DATA = '5d2a0003-8f4e-4c7a-b1d3-6e9f2a4c8b10';

/** No frame for this long while a command runs: the link is gone. */
const IDLE_TIMEOUT_MS = 10_000;

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

/**
 * Our own scan list instead of the system picker: only on Android. Web Bluetooth (Electron)
 * can only find devices through its picker, which electron/main.cjs answers itself.
 */
export const canScan = Capacitor.getPlatform() === 'android';

export interface RememberedLogger {
  deviceId: string;
  name: string;
}

const REMEMBER_KEY = 'pegscrape.logger';

/** The logger last connected to (Android connects to it directly, without scanning). */
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

const enc = new TextEncoder();
const dec = new TextDecoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** The same as zlib's crc32, continued from a previous value. */
function crc32(crc: number, bytes: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

type FrameHandler = (type: string, payload: Uint8Array) => void;

let initialized = false;

/** Ask for Bluetooth (and, on Android, its permissions). Throws a readable error when there is none. */
async function ensureBluetooth() {
  if (!initialized) {
    try {
      await BleClient.initialize({ androidNeverForLocation: true });
    } catch (e) {
      throw new LoggerError(
        Capacitor.isNativePlatform()
          ? `Bluetooth is not available: ${(e as Error).message}`
          : 'This browser has no Bluetooth. Use the Windows app or Chrome / Edge.',
      );
    }
    initialized = true;
  }
  if (Capacitor.getPlatform() === 'android' && !(await BleClient.isEnabled())) {
    await BleClient.requestEnable();
  }
}

export class LoggerLink {
  private handler: FrameHandler | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private connected = true;
  /** The logger's protocol version, from INFO. 2 adds GETZ (compressed download). */
  private proto = 1;

  private constructor(
    readonly deviceId: string,
    readonly name: string,
    private readonly onDisconnect: () => void,
  ) {}

  /**
   * Scan for loggers and report each one (again when its signal changes) to `onFound`.
   * Android only (see canScan). Resolves once scanning runs; call stopScan() to end it.
   */
  static async scan(onFound: (logger: FoundLogger) => void): Promise<void> {
    await ensureBluetooth();
    await BleClient.stopLEScan().catch(() => {});
    await BleClient.requestLEScan({ services: [LOGGER_SERVICE] }, (r) =>
      onFound({ deviceId: r.device.deviceId, name: r.localName || r.device.name || 'Logger', rssi: r.rssi ?? null }),
    );
  }

  static async stopScan() {
    await BleClient.stopLEScan().catch(() => {});
  }

  /**
   * Connect to a logger. With a deviceId (from scan() or a remembered logger, Android) it goes
   * straight there; without, the platform picks one (Electron takes the first one it finds).
   */
  static async connect(
    onDisconnect: () => void,
    target?: { deviceId: string; name: string },
    timeout = 15_000,
  ): Promise<LoggerLink> {
    await ensureBluetooth();
    let device: { deviceId: string; name?: string };
    if (target) {
      device = target;
    } else {
      try {
        device = await BleClient.requestDevice({ services: [LOGGER_SERVICE] });
      } catch (e) {
        const msg = (e as Error).message || '';
        if (/cancel|NotFoundError|chooser/i.test(msg)) throw new LoggerError('No logger found. Is its Bluetooth on (Settings on the logger)?');
        throw new LoggerError(msg);
      }
    }
    let link: LoggerLink;
    const lost = () => {
      if (!link) return;
      link.connected = false;
      link.handler?.('X', enc.encode('the logger disconnected'));
      onDisconnect();
    };
    try {
      await BleClient.connect(device.deviceId, lost, { timeout });
    } catch (e) {
      await BleClient.disconnect(device.deviceId).catch(() => {});
      throw new LoggerError(`Could not reach ${device.name ?? 'the logger'}. Is it on, with Bluetooth enabled?`);
    }
    link = new LoggerLink(device.deviceId, device.name ?? 'Logger', onDisconnect);
    if (Capacitor.getPlatform() === 'android') {
      // Shorter connection interval: several times faster downloads.
      await BleClient.requestConnectionPriority(device.deviceId, ConnectionPriority.CONNECTION_PRIORITY_HIGH).catch(() => {});
    }
    await BleClient.startNotifications(device.deviceId, LOGGER_SERVICE, DATA, (v) => {
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (bytes.length) link.handler?.(String.fromCharCode(bytes[0]), bytes.subarray(1));
    });
    return link;
  }

  get isConnected() {
    return this.connected;
  }

  async disconnect() {
    this.connected = false;
    await BleClient.disconnect(this.deviceId).catch(() => {});
    this.onDisconnect();
  }

  private async write(cmd: string) {
    const value = numbersToDataView([...enc.encode(cmd)]);
    try {
      await BleClient.write(this.deviceId, LOGGER_SERVICE, CMD, value);
    } catch {
      // A write can fail once while the logger streams notifications (seen on Windows): retry.
      await new Promise((r) => setTimeout(r, 200));
      await BleClient.write(this.deviceId, LOGGER_SERVICE, CMD, value);
    }
  }

  /**
   * Send a command and feed its frames to `onFrame` until it calls done/fail. One command at a
   * time: the frames carry no id. Fails when nothing arrives for IDLE_TIMEOUT_MS.
   */
  private run<T>(
    cmd: string,
    onFrame: (type: string, payload: Uint8Array, done: (v: T) => void, fail: (e: Error) => void) => void,
  ): Promise<T> {
    const next = this.busy.then(
      () =>
        new Promise<T>((resolve, reject) => {
          if (!this.connected) return reject(new LoggerError('Not connected to the logger.'));
          let timer = 0;
          const finish = () => {
            clearTimeout(timer);
            this.handler = null;
          };
          const done = (v: T) => {
            finish();
            resolve(v);
          };
          const fail = (e: Error) => {
            finish();
            reject(e);
          };
          const arm = () => {
            clearTimeout(timer);
            timer = window.setTimeout(() => fail(new LoggerError('The logger stopped answering.')), IDLE_TIMEOUT_MS);
          };
          this.handler = (type, payload) => {
            arm();
            if (type === 'X') fail(new LoggerError(dec.decode(payload)));
            else onFrame(type, payload, done, fail);
          };
          arm();
          this.write(cmd).catch((e) => fail(new LoggerError(`Could not send to the logger: ${(e as Error).message}`)));
        }),
    );
    this.busy = next.catch(() => {});
    return next;
  }

  info(): Promise<LoggerInfo> {
    return this.run('INFO', (type, p, done) => {
      if (type !== 'I') return;
      const kv = Object.fromEntries(dec.decode(p).split(';').map((s) => s.split('=') as [string, string]));
      this.proto = Number(kv.proto) || 1;
      done({ name: kv.name ?? this.name, recording: kv.rec === '1' });
    });
  }

  list(): Promise<LoggerFile[]> {
    const files: LoggerFile[] = [];
    return this.run('LS', (type, p, done) => {
      if (type === 'L') {
        const [name, size] = dec.decode(p).split('\t');
        files.push({ name, size: Number(size) });
      } else if (type === 'E') {
        done(files);
      }
    });
  }

  /** Download one ride. Aborting the signal stops the transfer on the logger too. */
  download(name: string, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<Blob> {
    if (this.proto >= 2 && typeof DecompressionStream !== 'undefined') {
      return this.downloadCompressed(name, onProgress, signal);
    }
    return this.downloadPlain(name, onProgress, signal);
  }

  /**
   * GETZ: the logger sends the file as a zlib stream, about 12 times smaller for a ride, so
   * 12 times fewer notifications (each one costs a trip through the Capacitor bridge on
   * Android). It's inflated here as it arrives; the CRC is over the inflated file.
   */
  private downloadCompressed(name: string, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<Blob> {
    const inflate = new DecompressionStream('deflate');
    const writer = inflate.writable.getWriter();
    const reader = inflate.readable.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    let received = 0;
    let crc = 0;
    let started = performance.now();
    let lastReport = 0;

    const inflated = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        parts.push(value);
        received += value.length;
        crc = crc32(crc, value);
        const now = performance.now();
        if (now - lastReport > 150) {
          lastReport = now;
          onProgress({ received, size, rate: (received / (now - started)) * 1000 });
        }
      }
    })();
    inflated.catch(() => {}); // reported at Z
    const stop = () => writer.abort().catch(() => {});
    const onAbort = () => this.write('ABORT').catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });

    return this.run<Blob>(`GETZ ${name}`, (type, p, done, fail) => {
      if (type === 'F') {
        size = u32(p, 0);
        started = performance.now();
        onProgress({ received: 0, size, rate: 0 });
      } else if (type === 'D') {
        writer.write(p.slice()).catch(() => {}); // the notification's buffer may be reused
      } else if (type === 'Z') {
        const want = u32(p, 0);
        writer
          .close()
          .then(() => inflated)
          .then(() => {
            if (received !== size) fail(new LoggerError(`${name}: got ${received} of ${size} bytes.`));
            else if (crc !== want) fail(new LoggerError(`${name}: the data arrived damaged (CRC). Try again.`));
            else {
              onProgress({ received, size, rate: (received / (performance.now() - started)) * 1000 });
              done(new Blob(parts as BlobPart[], { type: 'text/csv' }));
            }
          })
          .catch((e) => fail(new LoggerError(`${name}: the data arrived damaged (${(e as Error).message}). Try again.`)));
      } else if (type === 'A') {
        stop();
        fail(new DOMException('Cancelled', 'AbortError'));
      }
    })
      .catch((e) => {
        stop();
        throw e;
      })
      .finally(() => signal?.removeEventListener('abort', onAbort));
  }

  /** GET: the file as it is, for loggers without GETZ. */
  private downloadPlain(name: string, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<Blob> {
    const parts: Uint8Array[] = [];
    let size = 0;
    let received = 0;
    let crc = 0;
    let started = 0;
    let lastReport = 0;
    const onAbort = () => this.write('ABORT').catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });

    return this.run<Blob>(`GET ${name}`, (type, p, done, fail) => {
      if (type === 'F') {
        size = u32(p, 0);
        started = performance.now();
        onProgress({ received: 0, size, rate: 0 });
      } else if (type === 'D') {
        const chunk = p.slice(); // the notification's buffer may be reused
        parts.push(chunk);
        received += chunk.length;
        crc = crc32(crc, chunk);
        const now = performance.now();
        if (now - lastReport > 150) {
          lastReport = now;
          onProgress({ received, size, rate: (received / (now - started)) * 1000 });
        }
      } else if (type === 'Z') {
        if (received !== size) fail(new LoggerError(`${name}: got ${received} of ${size} bytes.`));
        else if (u32(p, 0) !== crc) fail(new LoggerError(`${name}: the data arrived damaged (CRC). Try again.`));
        else {
          onProgress({ received, size, rate: (received / (performance.now() - started)) * 1000 });
          done(new Blob(parts as BlobPart[], { type: 'text/csv' }));
        }
      } else if (type === 'A') {
        fail(new DOMException('Cancelled', 'AbortError'));
      }
    }).finally(() => signal?.removeEventListener('abort', onAbort));
  }

  remove(name: string): Promise<void> {
    return this.run(`DEL ${name}`, (type, _p, done) => {
      if (type === 'K') done(undefined);
    });
  }
}
