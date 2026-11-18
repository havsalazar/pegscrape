import type { PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FastForward, Minus, Plus, StepBack, StepForward } from 'lucide-react';
import type { Ride } from '@/lib/ride';
import type { Playback } from '@/hooks/usePlayback';
import { fmtDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  ride: Ride;
  pb: Playback;
  className?: string;
  /** Phone layout: shorter strips, bigger handle, touch-sized toolbar. */
  compact?: boolean;
}

/** Zoom levels for the detail strip, in seconds (Infinity = whole ride). */
const ZOOMS = [30, 60, 120, 300, 600, 1800, 3600, Infinity];

function zoomLabel(sec: number): string {
  if (!Number.isFinite(sec)) return 'All';
  return sec < 60 ? `${sec} s` : `${sec / 60} min`;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Index of the first row with time >= sec (relative to ride start). */
function lowerBound(ride: Ride, sec: number): number {
  const target = ride.t[0] + sec;
  let lo = 0,
    hi = ride.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ride.t[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Nice tick spacing (seconds) for a visible span, aiming for ~5 labels. */
function tickStep(span: number): number {
  const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  return steps.find((s) => span / s <= 6) ?? 14400;
}

/**
 * Draw speed (area), lean (bars: right up, left down), braking (red ticks) and no-fix shading
 * for the time range [from, to) into a canvas.
 */
function drawChart(cv: HTMLCanvasElement, ride: Ride, from: number, to: number, opts: { ticks: boolean }) {
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const span = to - from;
  const cols = W;
  const mid = H / 2;
  const s = ride.stats;
  const maxLean = Math.max(45, Math.min(90, Math.max(-s.maxLeanLeft.value, s.maxLeanRight.value)));
  const maxSpeed = Math.max(40, s.maxSpeed.value);

  const leanMin = new Float32Array(cols);
  const leanMax = new Float32Array(cols);
  const spd = new Float32Array(cols);
  const brk = new Float32Array(cols);
  const noFix = new Uint8Array(cols);
  const has = new Uint8Array(cols);
  const i0 = Math.max(0, lowerBound(ride, from) - 1);
  const i1 = Math.min(ride.n, lowerBound(ride, to) + 1);
  const t0 = ride.t[0];
  for (let i = i0; i < i1; i++) {
    const c = Math.floor(((ride.t[i] - t0 - from) / span) * cols);
    if (c < 0 || c >= cols) continue;
    const l = ride.lean[i];
    if (!has[c]) {
      has[c] = 1;
      leanMin[c] = Math.min(0, l);
      leanMax[c] = Math.max(0, l);
    }
    if (l < leanMin[c]) leanMin[c] = l;
    if (l > leanMax[c]) leanMax[c] = l;
    if (ride.speed[i] > spd[c]) spd[c] = ride.speed[i];
    if (ride.accel[i] < brk[c]) brk[c] = ride.accel[i];
    if (!ride.fix[i]) noFix[c] = 1;
  }
  // Zoomed in further than 1 row per pixel: hold each row's value across the empty columns.
  for (let c = 1; c < cols; c++) {
    if (!has[c] && has[c - 1]) {
      has[c] = 1;
      leanMin[c] = leanMin[c - 1];
      leanMax[c] = leanMax[c - 1];
      spd[c] = spd[c - 1];
      brk[c] = brk[c - 1];
      noFix[c] = noFix[c - 1];
    }
  }

  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let c = 0; c < cols; c++) if (noFix[c]) ctx.fillRect(c, 0, 1, H);

  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let c = 0; c < cols; c++) ctx.lineTo(c, H - (spd[c] / maxSpeed) * (H - 4));
  ctx.lineTo(cols, H);
  ctx.closePath();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = cssVar('--speed');
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(0, mid, cols, 1);
  const right = cssVar('--lean-right');
  const left = cssVar('--lean-left');
  const half = mid - 3;
  for (let c = 0; c < cols; c++) {
    const r = Math.min(1, leanMax[c] / maxLean) * half;
    const l = Math.min(1, -leanMin[c] / maxLean) * half;
    if (r > 0.5) {
      ctx.fillStyle = right;
      ctx.fillRect(c, mid - r, 1, r);
    }
    if (l > 0.5) {
      ctx.fillStyle = left;
      ctx.fillRect(c, mid + 1, 1, l);
    }
  }

  ctx.fillStyle = cssVar('--brake');
  for (let c = 0; c < cols; c++) {
    if (brk[c] <= -0.3) {
      const h = Math.min(1, -brk[c]) * (H * 0.12) + 2;
      ctx.fillRect(c, H - h, 1, h);
    }
  }

  if (opts.ticks) {
    const step = tickStep(span);
    ctx.font = '10px Inter Variable, sans-serif';
    ctx.textBaseline = 'top';
    for (let tk = Math.ceil(from / step) * step; tk < to; tk += step) {
      const x = Math.round(((tk - from) / span) * W) + 0.5;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x, 0, 1, H);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(fmtDuration(tk), x + 3, 2);
    }
  }
}

export function Timeline({ ride, pb, className, compact = false }: Props) {
  const { time, duration } = pb;
  // Only offer zoom levels that are meaningfully shorter than the ride.
  const zooms = useMemo(() => ZOOMS.filter((z) => !Number.isFinite(z) || z < duration * 0.8), [duration]);
  const defaultZoom = () => (duration <= 600 ? zooms.length - 1 : Math.max(0, zooms.indexOf(300)));
  const [zoomIdx, setZoomIdx] = useState(defaultZoom);
  const zi = Math.min(zoomIdx, zooms.length - 1);
  // Latest zoom/view in refs so rapid wheel events in one frame each take a step.
  const ziRef = useRef(zi);
  ziRef.current = zi;
  const windowSec = Math.min(zooms[zi], duration) || duration || 1;
  const [viewStart, setViewStart] = useState(0);

  // Reset when a new ride is loaded.
  useEffect(() => {
    setZoomIdx(defaultZoom());
    setViewStart(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ride]);

  // Keep the playhead inside the detail window: page forward during playback, re-centre on jumps.
  useEffect(() => {
    setViewStart((vs) => {
      const maxStart = Math.max(0, duration - windowSec);
      if (time >= vs && time <= vs + windowSec * 0.92) return Math.min(vs, maxStart);
      const ahead = pb.playing && time > vs + windowSec * 0.92 && time < vs + windowSec * 1.5;
      const next = ahead ? time - windowSec * 0.08 : time - windowSec / 2;
      return Math.max(0, Math.min(maxStart, next));
    });
  }, [time, windowSec, duration, pb.playing]);

  const viewEnd = viewStart + windowSec;
  const viewRef = useRef({ start: viewStart, span: windowSec });
  viewRef.current = { start: viewStart, span: windowSec };
  const zoomTo = (ni: number, anchor = time) => {
    ni = Math.max(0, Math.min(zooms.length - 1, ni));
    if (ni === ziRef.current) return;
    const { start, span } = viewRef.current;
    const nw = Math.min(zooms[ni], duration) || duration;
    const u = Math.max(0, Math.min(1, (anchor - start) / span));
    const ns = Math.max(0, Math.min(duration - nw, anchor - u * nw));
    ziRef.current = ni;
    viewRef.current = { start: ns, span: nw };
    setZoomIdx(ni);
    setViewStart(ns);
  };

  // ---- canvases ----
  const [overRef, overW] = useWidth<HTMLDivElement>();
  const [detRef, detW] = useWidth<HTMLDivElement>();
  const overCv = useRef<HTMLCanvasElement>(null);
  const detCv = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (overCv.current && overW) drawChart(overCv.current, ride, 0, duration, { ticks: false });
  }, [ride, overW, duration]);

  useEffect(() => {
    if (detCv.current && detW) drawChart(detCv.current, ride, viewStart, viewEnd, { ticks: true });
  }, [ride, detW, viewStart, viewEnd]);

  // ---- interaction ----
  const overDrag = useRef<number | null>(null);
  const detDrag = useRef<number | null>(null);
  const pinch = useRef<{ pointers: Map<number, number>; startDist: number; startIdx: number }>({
    pointers: new Map(),
    startDist: 0,
    startIdx: 0,
  });
  const [hover, setHover] = useState<number | null>(null);

  const xToTime = (el: HTMLElement, clientX: number, from: number, span: number) => {
    const r = el.getBoundingClientRect();
    return from + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * span;
  };

  const overHandlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      overDrag.current = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      pb.seek(xToTime(e.currentTarget, e.clientX, 0, duration));
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (overDrag.current === e.pointerId) pb.seek(xToTime(e.currentTarget, e.clientX, 0, duration));
    },
    onPointerUp: () => (overDrag.current = null),
    onPointerCancel: () => (overDrag.current = null),
  };

  const detailHandlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      const p = pinch.current;
      p.pointers.set(e.pointerId, e.clientX);
      if (p.pointers.size === 2) {
        // Second finger down: stop scrubbing, start pinch-zoom.
        const [a, b] = [...p.pointers.values()];
        p.startDist = Math.abs(a - b);
        p.startIdx = zi;
        detDrag.current = null;
        return;
      }
      detDrag.current = e.pointerId;
      pb.seek(xToTime(e.currentTarget, e.clientX, viewStart, windowSec));
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const p = pinch.current;
      if (p.pointers.has(e.pointerId)) p.pointers.set(e.pointerId, e.clientX);
      if (p.pointers.size === 2) {
        if (p.startDist > 20) {
          const [a, b] = [...p.pointers.values()];
          // Each doubling of the finger distance = one zoom step in.
          const steps = Math.round(-Math.log2(Math.max(0.05, Math.abs(a - b) / p.startDist)));
          zoomTo(p.startIdx + steps);
        }
        return;
      }
      const t = xToTime(e.currentTarget, e.clientX, viewStart, windowSec);
      if (e.pointerType === 'mouse') setHover(t);
      if (detDrag.current === e.pointerId) pb.seek(t);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      pinch.current.pointers.delete(e.pointerId);
      detDrag.current = null;
    },
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => {
      pinch.current.pointers.delete(e.pointerId);
      detDrag.current = null;
    },
    onPointerLeave: () => setHover(null),
    onWheel: (e: ReactWheelEvent<HTMLDivElement>) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Trackpad swipe / horizontal wheel: pan the window.
        setViewStart((vs) => Math.max(0, Math.min(duration - windowSec, vs + (e.deltaX / Math.max(1, detW)) * windowSec)));
        return;
      }
      zoomTo(ziRef.current + (e.deltaY < 0 ? -1 : 1), xToTime(e.currentTarget, e.clientX, viewRef.current.start, viewRef.current.span));
    },
  };

  // Keyboard: +/- zoom, PgUp/PgDn segments.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '+' || e.key === '=') zoomTo(zi - 1);
      else if (e.key === '-' || e.key === '_') zoomTo(zi + 1);
      else if (e.key === 'PageDown') {
        e.preventDefault();
        pb.nextSegment();
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        pb.prevSegment();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const pct = (t: number, from: number, span: number) => `${((t - from) / span) * 100}%`;
  const inView = time >= viewStart && time <= viewEnd;
  const zoomedIn = windowSec < duration * 0.999;
  const segCount = ride.segments.length;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {/* Toolbar */}
      <div className="flex items-center gap-1">
        <ToolButton label="Previous riding segment (PgUp)" onClick={pb.prevSegment} compact={compact} disabled={!segCount}>
          <StepBack />
        </ToolButton>
        <ToolButton label="Next riding segment (PgDn)" onClick={pb.nextSegment} compact={compact} disabled={!segCount}>
          <StepForward />
        </ToolButton>
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              size={compact ? 'lg' : 'sm'}
              pressed={pb.skipStops}
              onPressedChange={pb.setSkipStops}
              disabled={!segCount}
              aria-label="Skip stops"
              className="gap-1.5 px-2.5 text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90"
            >
              <FastForward /> Skip stops
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>Jump over stationary stretches while playing</TooltipContent>
        </Tooltip>
        {!compact && (
          <span className="ml-2 text-[11px] text-muted-foreground tabular-nums">
            {segCount} riding segment{segCount === 1 ? '' : 's'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <ToolButton label="Zoom out (−)" onClick={() => zoomTo(zi + 1)} compact={compact} disabled={zi >= zooms.length - 1}>
            <Minus />
          </ToolButton>
          <span className="min-w-12 text-center text-xs font-medium tabular-nums">{zoomLabel(zooms[zi])}</span>
          <ToolButton label="Zoom in (+)" onClick={() => zoomTo(zi - 1)} compact={compact} disabled={zi <= 0}>
            <Plus />
          </ToolButton>
        </div>
      </div>

      {/* Overview: whole ride, riding segments highlighted, box = visible window */}
      <div
        ref={overRef}
        className={cn('relative cursor-pointer touch-none overflow-hidden rounded-md border bg-muted/30 select-none', compact ? 'h-8' : 'h-6')}
        aria-label="Whole ride overview"
        {...overHandlers}
      >
        {ride.segments.map((s, k) => (
          <div
            key={k}
            className="pointer-events-none absolute inset-y-0 bg-throttle/20"
            style={{ left: pct(s.start, 0, duration), width: `max(2px, ${pct(s.end - s.start, 0, duration)})` }}
          />
        ))}
        <canvas ref={overCv} className="absolute inset-0 size-full opacity-80" />
        {zoomedIn && (
          <div
            className="pointer-events-none absolute inset-y-0 rounded-sm border-2 border-foreground/70 bg-foreground/10"
            style={{ left: pct(viewStart, 0, duration), width: `max(6px, ${pct(windowSec, 0, duration)})` }}
          />
        )}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: pct(time, 0, duration) }} />
      </div>

      {/* Detail: the zoomed window; drag for precise seeking, pinch / wheel to zoom */}
      <div
        ref={detRef}
        className={cn('relative cursor-pointer touch-none overflow-hidden rounded-md border bg-muted/30 select-none', compact ? 'h-16' : 'h-20')}
        aria-label="Zoomed timeline"
        {...detailHandlers}
      >
        <canvas ref={detCv} className="absolute inset-0 size-full" />
        {hover !== null && (
          <>
            <div className="pointer-events-none absolute inset-y-0 w-px bg-foreground/40" style={{ left: pct(hover, viewStart, windowSec) }} />
            <div
              className="pointer-events-none absolute bottom-1 -translate-x-1/2 rounded bg-popover px-1.5 py-0.5 text-[10px] tabular-nums text-popover-foreground shadow"
              style={{ left: `clamp(24px, ${pct(hover, viewStart, windowSec)}, calc(100% - 24px))` }}
            >
              {fmtDuration(hover)}
            </div>
          </>
        )}
        {inView && (
          <>
            <div
              className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground shadow-[0_0_6px_rgba(255,255,255,0.6)]"
              style={{ left: pct(time, viewStart, windowSec) }}
            />
            {compact && (
              <div
                className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow"
                style={{ left: pct(time, viewStart, windowSec) }}
              />
            )}
          </>
        )}
      </div>

      {!compact && (
        <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <Legend className="bg-lean-right" label="Lean R" />
            <Legend className="bg-lean-left" label="Lean L" />
            <Legend className="bg-speed/60" label="Speed" />
            <Legend className="bg-brake" label="Braking" />
            <Legend className="bg-throttle/40" label="Riding segment" />
          </div>
          <span className="tabular-nums">
            {fmtDuration(viewStart)} – {fmtDuration(viewEnd)}
          </span>
        </div>
      )}
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  compact,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  compact: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size={compact ? 'icon-lg' : 'icon-sm'} onClick={onClick} disabled={disabled} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="hidden items-center gap-1 sm:inline-flex">
      <span className={cn('inline-block size-2 rounded-sm', className)} />
      {label}
    </span>
  );
}
