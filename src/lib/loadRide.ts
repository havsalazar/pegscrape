import RideWorker from './rideLoader.worker?worker&inline';
import { parseRide, RideParseError, type Ride } from './ride';

export type LoadStage = 'reading' | 'parsing';

export type WorkerRequest = { file: File };
export type WorkerResponse =
  | { type: 'progress'; stage: LoadStage; fraction: number }
  | { type: 'done'; ride: Ride }
  | { type: 'error'; message: string; isParseError: boolean };

export interface LoadProgress {
  stage: LoadStage;
  /** Overall progress 0..1. */
  fraction: number;
}

/** Share of the overall bar given to reading the file (the rest is parsing). */
const READ_SHARE = 0.25;

const overall = (stage: LoadStage, f: number) =>
  stage === 'reading' ? f * READ_SHARE : READ_SHARE + f * (1 - READ_SHARE);

export interface LoadHandle {
  promise: Promise<Ride>;
  cancel: () => void;
}

/**
 * Load a ride CSV in a Web Worker so the UI stays responsive, reporting progress.
 * Falls back to the main thread if workers aren't available.
 */
export function loadRideFile(file: File, onProgress: (p: LoadProgress) => void): LoadHandle {
  let worker: Worker | null = null;
  try {
    worker = new RideWorker();
  } catch {
    worker = null;
  }

  if (!worker) {
    const promise = (async () => {
      onProgress({ stage: 'reading', fraction: 0 });
      const text = await file.text();
      onProgress({ stage: 'parsing', fraction: READ_SHARE });
      await new Promise((r) => setTimeout(r, 16)); // let the progress paint
      return parseRide(text, file.name);
    })();
    return { promise, cancel: () => {} };
  }

  const w = worker;
  let rejectFn: (e: Error) => void = () => {};
  const promise = new Promise<Ride>((resolve, reject) => {
    rejectFn = reject;
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress({ stage: msg.stage, fraction: overall(msg.stage, msg.fraction) });
      } else if (msg.type === 'done') {
        w.terminate();
        resolve(msg.ride);
      } else {
        w.terminate();
        reject(msg.isParseError ? new RideParseError(msg.message) : new Error(msg.message));
      }
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'The loader crashed.'));
    };
    onProgress({ stage: 'reading', fraction: 0 });
    w.postMessage({ file } satisfies WorkerRequest);
  });

  return {
    promise,
    cancel: () => {
      w.terminate();
      rejectFn(new DOMException('Cancelled', 'AbortError'));
    },
  };
}
