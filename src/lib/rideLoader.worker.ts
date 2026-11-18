/// <reference lib="webworker" />
// Reads and parses a ride CSV off the main thread, reporting progress as it goes.
import { parseRide, RideParseError, type Ride } from './ride';
import type { WorkerRequest, WorkerResponse } from './loadRide';

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

async function readText(file: File, onProgress: (f: number) => void): Promise<string> {
  // Stream the file so we can report progress on large logs.
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let loaded = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    parts.push(decoder.decode(value, { stream: true }));
    const f = file.size ? loaded / file.size : 1;
    if (f - lastReport >= 0.02) {
      lastReport = f;
      onProgress(f);
    }
  }
  parts.push(decoder.decode());
  return parts.join('');
}

function transferables(r: Ride): Transferable[] {
  return [
    r.t, r.lean, r.accel, r.speed, r.lat, r.lon, r.heading, r.fix, r.sats, r.epochMs, r.peakLeftSoFar, r.peakRightSoFar,
  ].map((a) => a.buffer as ArrayBuffer);
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { file } = e.data;
  try {
    const text = await readText(file, (p) => post({ type: 'progress', stage: 'reading', fraction: p }));
    let last = 0;
    const ride = parseRide(text, file.name, (p) => {
      if (p - last >= 0.02) {
        last = p;
        post({ type: 'progress', stage: 'parsing', fraction: p });
      }
    });
    post({ type: 'progress', stage: 'parsing', fraction: 1 });
    post({ type: 'done', ride }, transferables(ride));
  } catch (err) {
    post({
      type: 'error',
      message: (err as Error).message,
      isParseError: err instanceof RideParseError,
    });
  }
};
