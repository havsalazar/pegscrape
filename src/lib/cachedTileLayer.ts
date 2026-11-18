import L from 'leaflet';
import { getCachedTile, getTile } from '@/lib/tileCache';

/** How many zoom levels up to look for a cached parent tile when a tile is missing offline. */
const MAX_PARENT_LEVELS = 6;

/**
 * Leaflet tile layer backed by the IndexedDB tile cache.
 * - cached tile → shown immediately (works offline)
 * - not cached → downloaded and stored
 * - not cached and offline → the nearest cached lower-zoom tile, scaled up (blurry but useful)
 */
const CachedTileLayerImpl = L.TileLayer.extend({
  createTile(this: L.TileLayer & { _url: string }, coords: L.Coords, done: L.DoneCallback) {
    const tile = document.createElement('div');
    tile.style.overflow = 'hidden';
    const size = this.getTileSize();
    // coords.z is Leaflet's tile zoom; the URL zoom adds zoomOffset (used for high-DPI tiles).
    const offset = this.options.zoomOffset ?? 0;
    const url = (x: number, y: number, z: number) =>
      L.Util.template(this._url, { ...this.options, x, y, z: z + offset });

    const show = (blob: Blob, scale: number, offX: number, offY: number) => {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.style.cssText =
        `position:absolute;left:${-offX * size.x}px;top:${-offY * size.y}px;` +
        `width:${size.x * scale}px;height:${size.y * scale}px;max-width:none;`;
      const objectUrl = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        done(undefined, tile);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        done(new Error('bad tile image'), tile);
      };
      img.src = objectUrl;
      tile.appendChild(img);
    };

    void (async () => {
      const blob = await getTile(url(coords.x, coords.y, coords.z));
      if (blob) return show(blob, 1, 0, 0);
      for (let k = 1; k <= MAX_PARENT_LEVELS && coords.z + offset - k >= 0; k++) {
        const scale = 2 ** k;
        const px = Math.floor(coords.x / scale);
        const py = Math.floor(coords.y / scale);
        const parent = await getCachedTile(url(px, py, coords.z - k));
        if (parent) return show(parent, scale, coords.x - px * scale, coords.y - py * scale);
      }
      done(new Error('tile unavailable offline'), tile);
    })();

    return tile;
  },
});

export function cachedTileLayer(urlTemplate: string, options?: L.TileLayerOptions): L.TileLayer {
  return new (CachedTileLayerImpl as unknown as new (u: string, o?: L.TileLayerOptions) => L.TileLayer)(
    urlTemplate,
    options,
  );
}
