/**
 * Persistent map tile cache (IndexedDB). Every tile the map shows while online is stored, so
 * areas you've already looked at keep working without a connection.
 *
 * Only tiles that were actually displayed get cached; nothing is bulk-downloaded (Esri's terms
 * don't allow pre-fetching areas).
 */

// Kept from the app's old name (Incli) so existing saved tiles stay usable.
const DB_NAME = 'incli-tiles';
const STORE = 'tiles';
/** Roughly 300–600 MB depending on tile type; oldest-used tiles are evicted beyond this. */
export const MAX_TILES = 25_000;
/** Cached tiles older than this are refreshed in the background when online. */
const REFRESH_AFTER_MS = 30 * 24 * 3600 * 1000;

interface TileRecord {
  url: string;
  blob: Blob;
  /** When the tile was downloaded. */
  fetched: number;
  /** Last time it was shown (for LRU eviction). */
  used: number;
}

export interface CacheStats {
  tiles: number;
  bytes: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'url' });
        store.createIndex('used', 'used');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null); // IndexedDB unavailable: the map still works, just without the cache.
    }
  });
  return dbPromise;
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function getRecord(url: string): Promise<TileRecord | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  try {
    return await tx<TileRecord | undefined>(db, 'readonly', (s) => s.get(url));
  } catch {
    return undefined;
  }
}

let putsSinceEvict = 0;
const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    listeners.forEach((l) => l());
  }, 3000);
}

/** Subscribe to cache changes (debounced). Returns an unsubscribe function. */
export function onCacheChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function putRecord(rec: TileRecord) {
  const db = await openDb();
  if (!db) return;
  try {
    await tx(db, 'readwrite', (s) => s.put(rec));
    notify();
    if (++putsSinceEvict >= 200) {
      putsSinceEvict = 0;
      void evict(db);
    }
  } catch {
    // Quota exceeded or similar: free some space and carry on.
    void evict(db, 0.8);
  }
}

/** Mark a tile as recently used without rewriting the blob on every view. */
async function touch(rec: TileRecord) {
  if (Date.now() - rec.used < 24 * 3600 * 1000) return;
  await putRecord({ ...rec, used: Date.now() });
}

/** Drop the least recently used tiles until at most `fraction * MAX_TILES` remain. */
async function evict(db: IDBDatabase, fraction = 1) {
  const keep = Math.floor(MAX_TILES * fraction);
  const count = await tx<number>(db, 'readonly', (s) => s.count());
  let excess = count - keep;
  if (excess <= 0) return;
  await new Promise<void>((resolve) => {
    const t = db.transaction(STORE, 'readwrite');
    const cursorReq = t.objectStore(STORE).index('used').openCursor();
    cursorReq.onsuccess = () => {
      const c = cursorReq.result;
      if (!c || excess-- <= 0) return;
      c.delete();
      c.continue();
    };
    t.oncomplete = () => resolve();
    t.onerror = () => resolve();
  });
  notify();
}

async function download(url: string): Promise<Blob | null> {
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return null;
    return blob;
  } catch {
    return null; // offline / network error
  }
}

/**
 * Get a tile: from the cache if we have it (refreshing stale copies in the background),
 * otherwise from the network (and store it). Returns null when neither works.
 */
export async function getTile(url: string): Promise<Blob | null> {
  const cached = await getRecord(url);
  if (cached) {
    if (navigator.onLine && Date.now() - cached.fetched > REFRESH_AFTER_MS) {
      void download(url).then((blob) => blob && putRecord({ url, blob, fetched: Date.now(), used: Date.now() }));
    } else {
      void touch(cached);
    }
    return cached.blob;
  }
  const blob = await download(url);
  if (blob) void putRecord({ url, blob, fetched: Date.now(), used: Date.now() });
  return blob;
}

/** Cache-only lookup (used for the low-zoom fallback when a tile is missing offline). */
export async function getCachedTile(url: string): Promise<Blob | null> {
  return (await getRecord(url))?.blob ?? null;
}

export async function cacheStats(): Promise<CacheStats> {
  const db = await openDb();
  if (!db) return { tiles: 0, bytes: 0 };
  return new Promise((resolve) => {
    let tiles = 0;
    let bytes = 0;
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      tiles++;
      bytes += (c.value as TileRecord).blob.size;
      c.continue();
    };
    t.oncomplete = () => resolve({ tiles, bytes });
    t.onerror = () => resolve({ tiles, bytes });
  });
}

export async function clearCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await tx(db, 'readwrite', (s) => s.clear());
  notify();
}

/** Ask the browser not to evict our storage under pressure (best effort). */
export function requestPersistentStorage() {
  void navigator.storage?.persist?.().catch(() => {});
}
