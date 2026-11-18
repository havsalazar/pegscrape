/**
 * Rides saved in the app (IndexedDB), so they stay after being deleted from the logger.
 * The CSV and its metadata live in separate stores: listing the library never loads the files.
 */

const DB_NAME = 'pegscrape-rides';
const META = 'meta';
const DATA = 'data';

export interface SavedRide {
  /** "<logger name>/<file name>": two loggers can both have a RIDE0001.CSV. */
  id: string;
  name: string;
  device: string;
  size: number;
  savedAt: number;
  /** When the ride started (GPS time of the first row with a date), if known. */
  startedAt: number | null;
}

export const savedRideId = (device: string, name: string) => `${device}/${name}`;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META, { keyPath: 'id' });
      req.result.createObjectStore(DATA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the ride library.'));
    req.onblocked = () => reject(new Error('The ride library is open in another window.'));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Saving the ride was cancelled (storage full?).'));
  });
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Subscribe to library changes. Returns an unsubscribe function. */
export function onLibraryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Newest ride first. */
export async function listSavedRides(): Promise<SavedRide[]> {
  const db = await openDb();
  const rides = await new Promise<SavedRide[]>((resolve, reject) => {
    const r = db.transaction(META).objectStore(META).getAll();
    r.onsuccess = () => resolve(r.result as SavedRide[]);
    r.onerror = () => reject(r.error);
  });
  return rides.sort((a, b) => (b.startedAt ?? b.savedAt) - (a.startedAt ?? a.savedAt));
}

export async function saveRide(device: string, name: string, blob: Blob): Promise<SavedRide> {
  const ride: SavedRide = {
    id: savedRideId(device, name),
    name,
    device,
    size: blob.size,
    savedAt: Date.now(),
    startedAt: await rideStart(blob),
  };
  const db = await openDb();
  const t = db.transaction([META, DATA], 'readwrite');
  t.objectStore(DATA).put(blob, ride.id);
  t.objectStore(META).put(ride);
  await done(t);
  notify();
  return ride;
}

export async function loadSavedRide(ride: SavedRide): Promise<File> {
  const db = await openDb();
  const blob = await new Promise<Blob | undefined>((resolve, reject) => {
    const r = db.transaction(DATA).objectStore(DATA).get(ride.id);
    r.onsuccess = () => resolve(r.result as Blob | undefined);
    r.onerror = () => reject(r.error);
  });
  if (!blob) throw new Error(`${ride.name} is missing from the library.`);
  return new File([blob], ride.name, { type: 'text/csv' });
}

export async function deleteSavedRide(id: string): Promise<void> {
  const db = await openDb();
  const t = db.transaction([META, DATA], 'readwrite');
  t.objectStore(DATA).delete(id);
  t.objectStore(META).delete(id);
  await done(t);
  notify();
}

/**
 * The first "date,utc" pair in the log (time_s,date,utc,...). Both are empty until the GPS has a
 * fix, so look through the first 256 KB.
 */
async function rideStart(blob: Blob): Promise<number | null> {
  const text = await blob.slice(0, 256 * 1024).text();
  for (const line of text.split('\n').slice(1)) {
    const [, date, utc] = line.split(',');
    if (date && utc) {
      const t = Date.parse(`${date}T${utc}Z`);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}
