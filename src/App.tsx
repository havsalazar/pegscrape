import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bluetooth, ChartNoAxesColumn, CloudOff, Crosshair, FileUp, Gauge, MoveDiagonal, Zap } from 'lucide-react';
import { RidesSheet } from '@/components/RidesSheet';
import { frameAt, RideParseError, type Ride } from '@/lib/ride';
import { loadRideFile, type LoadHandle, type LoadProgress } from '@/lib/loadRide';
import { requestPersistentStorage } from '@/lib/tileCache';
import { useOnline } from '@/hooks/useOnline';
import { ProgressRing } from '@/components/ProgressRing';
import { MapCacheCard } from '@/components/MapCacheCard';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usePlayback } from '@/hooks/usePlayback';
import { RideMap, RAMPS, type ColorMode } from '@/components/RideMap';
import { BikeLean } from '@/components/BikeLean';
import { CompactTelemetry, LeanReadout, TelemetryRow } from '@/components/Telemetry';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useMediaQuery, WIDE_LAYOUT_QUERY } from '@/hooks/useMediaQuery';
import { StatsCard } from '@/components/StatsCard';
import { Timeline } from '@/components/Timeline';
import { PlaybackControls } from '@/components/PlaybackControls';
import { OpenRide, STAGE_LABEL } from '@/components/OpenRide';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// Android's file chooser often reports SD-card CSVs as octet-stream, so only filter on desktop.
const IS_ANDROID = /Android/i.test(navigator.userAgent);

export default function App() {
  const [ride, setRide] = useState<Ride | null>(null);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const loading = progress !== null;
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [follow, setFollow] = useState(true);
  const [colorMode, setColorMode] = useState<ColorMode>('speed');
  const inputRef = useRef<HTMLInputElement>(null);
  const loadRef = useRef<LoadHandle | null>(null);
  const pb = usePlayback(ride);
  const online = useOnline();
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [ridesOpen, setRidesOpen] = useState(false);

  const frame = useMemo(() => (ride ? frameAt(ride, pb.time) : null), [ride, pb.time]);

  useEffect(() => requestPersistentStorage(), []);

  const loadFile = useCallback(async (file: File) => {
    loadRef.current?.cancel(); // a newer file replaces one still loading
    setError(null);
    pb.pause();
    const handle = loadRideFile(file, setProgress);
    loadRef.current = handle;
    try {
      const parsed = await handle.promise;
      setRide(parsed);
      setFollow(true);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof RideParseError ? e.message : `Could not read the file: ${(e as Error).message}`);
    } finally {
      if (loadRef.current === handle) {
        loadRef.current = null;
        setProgress(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = useCallback(() => inputRef.current?.click(), []);

  // Drag & drop anywhere (desktop; Tauri's own file drop is off so the page gets the events).
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) loadFile(f);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [loadFile]);

  // Keyboard shortcuts.
  useEffect(() => {
    if (!ride) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const big = e.shiftKey ? 6 : 1;
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          pb.toggle();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          pb.skip(-10 * big);
          break;
        case 'ArrowRight':
          e.preventDefault();
          pb.skip(10 * big);
          break;
        case ',':
          pb.skip(-0.1);
          break;
        case '.':
          pb.skip(0.1);
          break;
        case '[':
          pb.slower();
          break;
        case ']':
          pb.faster();
          break;
        case 'Home':
          pb.seek(0);
          break;
        case 'End':
          pb.seek(pb.duration);
          break;
        case 'f':
          setFollow((v) => !v);
          break;
        case 'o':
          if (e.ctrlKey) {
            e.preventDefault();
            pick();
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ride, pb, pick]);

  const startDate = ride ? fmtDate(ride.epochMs[0]) : '';

  return (
    <TooltipProvider>
      <div
        className="flex h-dvh flex-col"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept={IS_ANDROID ? undefined : '.csv,text/csv'}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) loadFile(f);
            e.target.value = '';
          }}
        />

        {/* Header */}
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
          <div className="flex items-center gap-2 font-semibold">
            <MoveDiagonal className="size-4 text-lean-right" />
            Pegscrape
          </div>
          {ride && (
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <Badge variant="secondary" className="truncate">
                {ride.name}
              </Badge>
              <span className="hidden truncate text-muted-foreground sm:inline">
                {startDate} · {ride.n.toLocaleString()} rows
                {ride.skippedRows > 0 && ` · ${ride.skippedRows} skipped`}
              </span>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button size={wide ? 'sm' : 'icon'} variant="outline" onClick={() => setRidesOpen(true)} aria-label="Rides">
              <Bluetooth />
              {wide && <span>Rides</span>}
            </Button>
            {ride && !wide && (
              <Button size="icon" variant="outline" onClick={() => setSummaryOpen(true)} aria-label="Ride summary">
                <ChartNoAxesColumn />
              </Button>
            )}
            {ride && (
              <Button size={wide ? 'sm' : 'icon'} variant="outline" onClick={pick} disabled={loading} aria-label="Open ride">
                <FileUp />
                {wide && <span>Open ride</span>}
              </Button>
            )}
          </div>
        </header>

        <RidesSheet open={ridesOpen} onOpenChange={setRidesOpen} onOpenRide={loadFile} side={wide ? 'right' : 'bottom'} />

        {!ride ? (
          <main className="min-h-0 flex-1">
            <OpenRide
              onPick={pick}
              onRides={() => setRidesOpen(true)}
              progress={progress}
              error={error}
              dragging={dragging}
            />
          </main>
        ) : (
          (() => {
            const mapSection = (
              <section className="relative min-h-0 flex-1">
                <RideMap
                  ride={ride}
                  lat={frame!.lat}
                  lon={frame!.lon}
                  heading={frame!.heading}
                  follow={follow}
                  colorMode={colorMode}
                  onSeekIndex={pb.seekIndex}
                  onUserPan={() => setFollow(false)}
                />
                <MapOverlay colorMode={colorMode} setColorMode={setColorMode} follow={follow} setFollow={setFollow} compact={!wide} />
                {!online && (
                  <Badge variant="secondary" className="absolute top-3 left-16 z-[500] gap-1.5 bg-card/90 py-1 shadow-md backdrop-blur">
                    <CloudOff /> {wide ? 'Offline: showing saved map tiles' : 'Offline'}
                  </Badge>
                )}
                {error && (
                  <div className="absolute inset-x-3 top-3 z-[500] rounded-md bg-destructive/90 px-3 py-2 text-sm text-white">{error}</div>
                )}
              </section>
            );
            const bike = (className: string) => (
              <BikeLean
                lean={frame!.lean}
                peakLeft={ride.peakLeftSoFar[frame!.index]}
                peakRight={ride.peakRightSoFar[frame!.index]}
                className={className}
              />
            );

            if (!wide) {
              // Phone (portrait): big map, one compact HUD row, thumb-sized controls. Nothing scrolls;
              // the ride summary lives in a bottom sheet opened from the header.
              return (
                <>
                  <main className="flex min-h-0 flex-1 flex-col">
                    {mapSection}
                    <div className="grid shrink-0 grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-center gap-2 border-t px-2 py-2">
                      {bike('max-h-[22dvh]')}
                      <CompactTelemetry frame={frame!} />
                    </div>
                  </main>
                  <footer className="flex shrink-0 flex-col gap-2 border-t bg-background px-3 pt-2 pb-2">
                    <Timeline ride={ride} pb={pb} compact />
                    <PlaybackControls pb={pb} touch />
                  </footer>
                </>
              );
            }

            return (
              <>
                <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(300px,400px)]">
                  {mapSection}
                  <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l p-3">
                    <Card className="gap-2 py-3">
                      <CardContent className="flex flex-col gap-1 px-3">
                        {bike('mx-auto')}
                        <LeanReadout lean={frame!.lean} />
                        {Math.abs(frame!.lean) > 90 && (
                          <p className="text-center text-xs text-muted-foreground">Sensor reading beyond 90°: bike image clamped.</p>
                        )}
                      </CardContent>
                    </Card>
                    <Card className="py-4">
                      <CardContent className="px-4">
                        <TelemetryRow frame={frame!} />
                      </CardContent>
                    </Card>
                    <StatsCard ride={ride} onJump={pb.seekIndex} />
                    <MapCacheCard />
                  </aside>
                </main>
                <footer className="flex shrink-0 flex-col gap-2 border-t bg-background p-3">
                  <Timeline ride={ride} pb={pb} />
                  <PlaybackControls pb={pb} />
                </footer>
              </>
            );
          })()
        )}

        {ride && !wide && (
          <Sheet open={summaryOpen} onOpenChange={setSummaryOpen}>
            <SheetContent side="bottom" onOpenAutoFocus={(e) => e.preventDefault()} className="max-h-[85dvh] gap-0 overflow-y-auto rounded-t-xl pb-[env(safe-area-inset-bottom)]">
              <SheetHeader className="pb-2">
                <SheetTitle>{ride.name}</SheetTitle>
                <SheetDescription>
                  {startDate} · {ride.n.toLocaleString()} rows
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-3 px-3 pb-4">
                <StatsCard
                  ride={ride}
                  onJump={(i) => {
                    pb.seekIndex(i);
                    setSummaryOpen(false);
                  }}
                />
                <MapCacheCard />
              </div>
            </SheetContent>
          </Sheet>
        )}

        {progress && ride && (
          <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-background/75 backdrop-blur-sm">
            <ProgressRing value={progress.fraction} size={120} label={STAGE_LABEL[progress.stage]} />
          </div>
        )}

        {dragging && ride && (
          <div className="pointer-events-none fixed inset-0 z-[2000] flex items-center justify-center bg-background/70 text-lg font-medium backdrop-blur-sm">
            Drop the CSV to open it
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

function MapOverlay({
  colorMode,
  setColorMode,
  follow,
  setFollow,
  compact,
}: {
  colorMode: ColorMode;
  setColorMode: (m: ColorMode) => void;
  follow: boolean;
  setFollow: (v: boolean) => void;
  /** Phone layout: icon-only, 40 px touch targets, no legend. */
  compact: boolean;
}) {
  const ramp = RAMPS[colorMode];
  const item = compact ? 'size-10 px-0' : 'px-2 text-xs';
  const label = (text: string) => (compact ? null : <span>{text}</span>);
  return (
    <div className={cn('absolute right-3 z-[500] flex flex-col items-end gap-2', compact ? 'bottom-3' : 'bottom-6')}>
      <div className="flex items-center gap-1 rounded-lg border bg-card/90 p-1 shadow-md backdrop-blur">
        <ToggleGroup
          type="single"
          size={compact ? 'lg' : 'sm'}
          value={colorMode}
          onValueChange={(v) => v && setColorMode(v as ColorMode)}
          aria-label="Track colour"
        >
          <ToggleGroupItem value="speed" className={item} aria-label="Colour by speed">
            <Gauge /> {label('Speed')}
          </ToggleGroupItem>
          <ToggleGroupItem value="lean" className={item} aria-label="Colour by lean">
            <MoveDiagonal /> {label('Lean')}
          </ToggleGroupItem>
          <ToggleGroupItem value="g" className={item} aria-label="Colour by g">
            <Zap /> {label('G')}
          </ToggleGroupItem>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              size={compact ? 'lg' : 'sm'}
              pressed={follow}
              onPressedChange={setFollow}
              aria-label="Follow rider"
              className={cn(item, 'aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90')}
            >
              <Crosshair /> {label('Follow')}
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>Keep the rider in view (F)</TooltipContent>
        </Tooltip>
      </div>
      {!compact && (
        <div className="flex w-56 flex-col gap-1 rounded-lg border bg-card/90 px-2 py-1.5 text-[10px] text-muted-foreground shadow-md backdrop-blur">
          <div className="h-2 rounded-full" style={{ background: `linear-gradient(to right, ${ramp.stops.join(',')})` }} />
          <div className="flex justify-between tabular-nums">
            <span>{ramp.label(ramp.min)}</span>
            <span>{ramp.label(ramp.max)}+</span>
          </div>
        </div>
      )}
    </div>
  );
}
