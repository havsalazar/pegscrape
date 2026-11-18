import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { Ride, GpsSample } from '@/lib/ride';
import { cachedTileLayer } from '@/lib/cachedTileLayer';

export type ColorMode = 'speed' | 'lean' | 'g';

interface Props {
  ride: Ride;
  lat: number;
  lon: number;
  heading: number;
  follow: boolean;
  colorMode: ColorMode;
  onSeekIndex: (index: number) => void;
  onUserPan: () => void;
}

// Esri basemaps: keyless, and they load in both Tauri webviews (WebView2 and Android WebView).
// Tiles go through the offline cache (see lib/tileCache.ts).
/** Deepest zoom with real tiles for Street_Map and Imagery (checked: level 20 returns a placeholder). */
const MAX_NATIVE_ZOOM = 19;
export const MAP_MAX_ZOOM = MAX_NATIVE_ZOOM;
/** On high-density screens fetch the next zoom level at half size so tiles stay sharp. */
const HI_DPI = window.devicePixelRatio >= 1.5;
const STREET_ATTR = '&copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';

const esri = (service: string, attribution: string, className?: string) =>
  cachedTileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`, {
    // One above the map max so detectRetina (which lowers it by 1) still covers the top zoom.
    maxZoom: MAP_MAX_ZOOM + 1,
    maxNativeZoom: HI_DPI ? MAX_NATIVE_ZOOM - 1 : MAX_NATIVE_ZOOM,
    detectRetina: HI_DPI,
    attribution,
    className,
  });

const TILE_LAYERS = {
  // Esri's own dark canvas only has tiles to zoom 16 (pixelated beyond), so the dark style is the
  // street map (real tiles to 19) recoloured with a CSS filter (see .tiles-dark in index.css).
  Dark: esri('World_Street_Map', STREET_ATTR, 'tiles-dark'),
  Streets: esri('World_Street_Map', STREET_ATTR),
  Satellite: L.layerGroup([
    esri('World_Imagery', '&copy; Esri, Maxar, Earthstar Geographics'),
    esri('Reference/World_Boundaries_and_Places', ''),
  ]),
};

/** Shared colour ramps so the legend and the track agree. */
export const RAMPS: Record<ColorMode, { stops: string[]; min: number; max: number; label: (v: number) => string }> = {
  speed: {
    stops: ['#3b82f6', '#22d3ee', '#a3e635', '#facc15', '#f97316', '#ef4444'],
    min: 0,
    max: 120,
    label: (v) => `${v} km/h`,
  },
  lean: {
    stops: ['#22c55e', '#a3e635', '#facc15', '#f97316', '#ef4444', '#d946ef'],
    min: 0,
    max: 55,
    label: (v) => `${v}°`,
  },
  g: {
    stops: ['#ef4444', '#f97316', '#71717a', '#71717a', '#4ade80', '#22c55e'],
    min: -0.8,
    max: 0.5,
    label: (v) => `${v > 0 ? '+' : ''}${v} g`,
  },
};

const BUCKETS = 24;

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rampColor(mode: ColorMode, u: number): string {
  const stops = RAMPS[mode].stops.map(hexToRgb);
  const x = Math.max(0, Math.min(1, u)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function sampleValue(s: GpsSample, mode: ColorMode): number {
  if (mode === 'speed') return s.speed;
  if (mode === 'lean') return s.maxAbsLean;
  return s.peakAccel;
}

function bucketOf(s: GpsSample, mode: ColorMode): number {
  const r = RAMPS[mode];
  const u = (sampleValue(s, mode) - r.min) / (r.max - r.min);
  return Math.round(Math.max(0, Math.min(1, u)) * (BUCKETS - 1));
}

const arrowIcon = L.divIcon({
  className: 'rider-marker',
  iconSize: [40, 40],
  iconAnchor: [20, 20],
  html: `<div class="rider-arrow" style="width:40px;height:40px;will-change:transform">
    <svg viewBox="0 0 40 40" width="40" height="40">
      <circle cx="20" cy="20" r="18" fill="rgba(249,115,22,0.25)" />
      <path d="M20 1 L25.5 9 L14.5 9 Z" fill="#f97316" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>
      <circle cx="20" cy="20" r="9" fill="#f97316" stroke="#fff" stroke-width="3" />
    </svg></div>`,
});

function dot(color: string, label: string) {
  return L.divIcon({
    className: 'rider-marker',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    html: `<div title="${label}" style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.4)"></div>`,
  });
}

export function RideMap({ ride, lat, lon, heading, follow, colorMode, onSeekIndex, onUserPan }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const trackRef = useRef<L.LayerGroup | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const zoomingRef = useRef(false);
  const cbRef = useRef({ onSeekIndex, onUserPan });
  cbRef.current = { onSeekIndex, onUserPan };
  const rideRef = useRef(ride);
  rideRef.current = ride;

  // Create the map once.
  useEffect(() => {
    const map = L.map(elRef.current!, {
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true,
      maxZoom: MAP_MAX_ZOOM,
      layers: [TILE_LAYERS.Dark],
    }).setView([3.45, -76.53], 13);
    // Keep the required tile credits, drop Leaflet's own "🇺🇦 Leaflet" prefix (optional under its licence).
    map.attributionControl.setPrefix(false);
    L.control.layers(TILE_LAYERS, undefined, { position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    map.on('dragstart', () => cbRef.current.onUserPan());
    // Don't fight Leaflet's zoom animation; follow resumes on the next frame after it ends.
    map.on('zoomstart', () => (zoomingRef.current = true));
    map.on('zoomend', () => (zoomingRef.current = false));

    // Click on the track to jump there.
    map.on('click', (e: L.LeafletMouseEvent) => {
      const r = rideRef.current;
      const p = map.latLngToContainerPoint(e.latlng);
      let best = -1;
      let bestD = 28 * 28; // px²
      for (const s of r.samples) {
        const q = map.latLngToContainerPoint([s.lat, s.lon]);
        const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = s.i;
        }
      }
      if (best >= 0) cbRef.current.onSeekIndex(best);
    });

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(elRef.current!);
    mapRef.current = map;
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // (Re)draw the track when the ride or colour mode changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    trackRef.current?.remove();
    const group = L.layerGroup().addTo(map);
    trackRef.current = group;
    const renderer = L.canvas({ padding: 0.5, tolerance: 6 });
    const S = ride.samples;

    // Casing underneath for contrast on any basemap.
    let casing: L.LatLngExpression[] = [];
    const flushCasing = () => {
      if (casing.length > 1) L.polyline(casing, { renderer, color: '#000', weight: 7, opacity: 0.55, interactive: false }).addTo(group);
      casing = [];
    };
    for (const s of S) {
      if (s.gapBefore) flushCasing();
      casing.push([s.lat, s.lon]);
    }
    flushCasing();

    // Merge consecutive segments with the same colour bucket into one polyline.
    let run: L.LatLngExpression[] = [];
    let runBucket = -1;
    const flush = () => {
      if (run.length > 1) {
        L.polyline(run, {
          renderer,
          color: rampColor(colorMode, runBucket / (BUCKETS - 1)),
          weight: 4,
          opacity: 0.95,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false,
        }).addTo(group);
      }
    };
    for (let k = 0; k < S.length; k++) {
      const s = S[k];
      const b = bucketOf(s, colorMode);
      if (s.gapBefore || b !== runBucket) {
        const prev = run[run.length - 1];
        flush();
        run = !s.gapBefore && prev ? [prev] : [];
        runBucket = b;
      }
      run.push([s.lat, s.lon]);
    }
    flush();

    if (S.length) {
      L.marker([S[0].lat, S[0].lon], { icon: dot('#22c55e', 'Start'), interactive: false }).addTo(group);
      const e = S[S.length - 1];
      L.marker([e.lat, e.lon], { icon: dot('#ef4444', 'Finish'), interactive: false }).addTo(group);
    }
    return () => {
      group.remove();
    };
  }, [ride, colorMode]);

  // Fit to the ride when it is loaded.
  useEffect(() => {
    const map = mapRef.current;
    if (map && ride.bounds) map.fitBounds(ride.bounds, { padding: [30, 30], maxZoom: 17 });
  }, [ride]);

  // Rider marker: updated imperatively every frame.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const valid = Number.isFinite(lat) && Number.isFinite(lon);
    if (!valid) {
      markerRef.current?.setOpacity(0.35);
      return;
    }
    if (!markerRef.current) {
      markerRef.current = L.marker([lat, lon], { icon: arrowIcon, interactive: false, zIndexOffset: 1000, keyboard: false }).addTo(map);
    } else {
      markerRef.current.setLatLng([lat, lon]).setOpacity(1);
    }
    const arrow = markerRef.current.getElement()?.querySelector<HTMLDivElement>('.rider-arrow');
    if (arrow) arrow.style.transform = `rotate(${Number.isFinite(heading) ? heading : 0}deg)`;
    // Follow: lock the map centre to the rider. Positions are interpolated every frame, so an
    // un-animated pan per frame is smooth (an animated pan would be restarted every frame and stall).
    if (follow && !zoomingRef.current) map.panTo([lat, lon], { animate: false });
  }, [lat, lon, heading, follow]);

  // Remove the rider marker when the ride changes.
  useEffect(
    () => () => {
      markerRef.current?.remove();
      markerRef.current = null;
    },
    [ride],
  );

  return <div ref={elRef} className="size-full" />;
}
