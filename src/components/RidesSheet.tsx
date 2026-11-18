import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bluetooth,
  BluetoothOff,
  BluetoothSearching,
  Check,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Trash2,
  X,
} from 'lucide-react';
import {
  canScan,
  LoggerError,
  LoggerLink,
  rememberedLogger,
  rememberLogger,
  type DownloadProgress,
  type FoundLogger,
  type LoggerFile,
  type RememberedLogger,
} from '@/lib/loggerLink';
import {
  deleteSavedRide,
  listSavedRides,
  loadSavedRide,
  onLibraryChange,
  saveRide,
  savedRideId,
  type SavedRide,
} from '@/lib/rideLibrary';
import { fmtBytes, fmtDate } from '@/lib/format';
import { keepAliveStart, keepAliveStop } from '@/lib/keepAlive';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Show a saved ride in the viewer. */
  onOpenRide: (file: File) => void;
  side: 'right' | 'bottom';
}

type Job =
  | { kind: 'download'; name: string; index: number; total: number; progress: DownloadProgress | null }
  | { kind: 'delete'; name: string; index: number; total: number };

interface ScanState {
  found: FoundLogger[];
  scanning: boolean;
  /** Why the list is shown, e.g. the remembered logger didn't answer. */
  note: string | null;
}

/** How long one scan runs. */
const SCAN_MS = 10_000;
/** Connecting straight to the remembered logger gives up sooner, then shows the scan list. */
const QUICK_CONNECT_MS = 8_000;

type Confirm ={ kind: 'logger'; names: string[] } | { kind: 'saved'; ride: SavedRide };

const errorText = (e: unknown) => {
  const msg = (e as Error).message ?? String(e);
  if (/recording/i.test(msg)) return 'The logger is recording. Stop the recording on the logger, then refresh.';
  if (/no SD card/i.test(msg)) return 'The logger has no SD card.';
  if (/low memory/i.test(msg)) return 'The logger is low on memory and could not read its card. Restart the logger and try again.';
  return e instanceof LoggerError ? msg : `Bluetooth error: ${msg}`;
};

export function RidesSheet({ open, onOpenChange, onOpenRide, side }: Props) {
  const [link, setLink] = useState<LoggerLink | null>(null);
  const [device, setDevice] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [files, setFiles] = useState<LoggerFile[] | null>(null);
  const [listing, setListing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<Job | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedRide[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const [remembered, setRemembered] = useState<RememberedLogger | null>(rememberedLogger);
  const [scan, setScan] = useState<ScanState | null>(null);
  const scanTimer = useRef(0);

  // The library, kept in sync with downloads and deletes.
  useEffect(() => {
    const load = () => listSavedRides().then(setSaved, () => setSaved([]));
    load();
    return onLibraryChange(load);
  }, []);
  const savedIds = useMemo(() => new Map(saved.map((r) => [r.id, r])), [saved]);
  const isSaved = (f: LoggerFile) => savedIds.get(savedRideId(device, f.name))?.size === f.size;

  const refresh = useCallback(async (l: LoggerLink) => {
    setListing(true);
    setError(null);
    try {
      const list = await l.list();
      setFiles(list);
      setSelected((s) => new Set([...s].filter((n) => list.some((f) => f.name === n))));
    } catch (e) {
      setFiles(null);
      setError(errorText(e));
    } finally {
      setListing(false);
    }
  }, []);

  const stopScan = useCallback(() => {
    clearTimeout(scanTimer.current);
    void LoggerLink.stopScan();
    setScan((s) => (s ? { ...s, scanning: false } : s));
  }, []);

  /** Show our own list of nearby loggers (Android), scanning for SCAN_MS. */
  const startScan = async (note: string | null = null) => {
    setError(null);
    setScan({ found: [], scanning: true, note });
    try {
      await LoggerLink.scan((d) =>
        setScan((s) => {
          if (!s) return s;
          const found = s.found.some((f) => f.deviceId === d.deviceId)
            ? s.found.map((f) => (f.deviceId === d.deviceId ? d : f))
            : [...s.found, d];
          return { ...s, found };
        }),
      );
      clearTimeout(scanTimer.current);
      scanTimer.current = window.setTimeout(stopScan, SCAN_MS);
    } catch (e) {
      setScan(null);
      setError(errorText(e));
    }
  };

  const closeScan = () => {
    stopScan();
    setScan(null);
  };

  // Stop scanning when the sheet closes or goes away.
  useEffect(() => {
    if (!open) closeScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => void LoggerLink.stopScan(), []);

  /** Connect to `target` (a scanned or remembered logger) or, without one, let the platform pick. */
  const connectTo = async (target?: RememberedLogger, quick = false) => {
    if (scan) closeScan();
    setConnecting(true);
    setError(null);
    try {
      const l = await LoggerLink.connect(
        () => {
          abortRef.current?.abort();
          setLink(null);
          setFiles(null);
          setJob(null);
        },
        target,
        quick ? QUICK_CONNECT_MS : undefined,
      );
      const info = await l.info();
      setDevice(info.name);
      setLink(l);
      if (canScan) {
        const r = { deviceId: l.deviceId, name: info.name };
        rememberLogger(r);
        setRemembered(r);
      }
      await refresh(l);
    } catch (e) {
      // The remembered logger is off or out of range: let the rider pick one.
      if (quick && target) {
        setConnecting(false);
        await startScan(`${target.name} didn't answer. Pick a logger:`);
        return;
      }
      setError(errorText(e));
    } finally {
      setConnecting(false);
    }
  };

  const connect = () => {
    if (!canScan) return connectTo();
    if (remembered) return connectTo(remembered, true);
    return startScan();
  };

  const forget = () => {
    rememberLogger(null);
    setRemembered(null);
  };

  const disconnect = () => {
    abortRef.current?.abort();
    void link?.disconnect();
  };

  const toggle = (name: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const download = async (names: string[]) => {
    if (!link) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setError(null);
    await keepAliveStart(names.length === 1 ? `Downloading ${names[0]}` : `Downloading ${names.length} rides`);
    try {
      for (const [i, name] of names.entries()) {
        setJob({ kind: 'download', name, index: i, total: names.length, progress: null });
        const blob = await link.download(
          name,
          (progress) => setJob({ kind: 'download', name, index: i, total: names.length, progress }),
          ac.signal,
        );
        await saveRide(device, name, blob);
      }
      setSelected(new Set());
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(errorText(e));
    } finally {
      void keepAliveStop();
      abortRef.current = null;
      setJob(null);
    }
  };

  const removeFromLogger = async (names: string[]) => {
    if (!link) return;
    setConfirm(null);
    setError(null);
    try {
      for (const [i, name] of names.entries()) {
        setJob({ kind: 'delete', name, index: i, total: names.length });
        await link.remove(name);
      }
      setSelected(new Set());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setJob(null);
      await refresh(link);
    }
  };

  const removeSaved = async (ride: SavedRide) => {
    setConfirm(null);
    try {
      await deleteSavedRide(ride.id);
    } catch (e) {
      setError(`Could not delete ${ride.name}: ${(e as Error).message}`);
    }
  };

  const openSaved = async (ride: SavedRide) => {
    try {
      const file = await loadSavedRide(ride);
      onOpenChange(false);
      onOpenRide(file);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const busy = job !== null || listing;
  const selectedNames = files?.filter((f) => selected.has(f.name)).map((f) => f.name) ?? [];
  const unsavedSelected = files?.filter((f) => selected.has(f.name) && !isSaved(f)).length ?? 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={cn(
          'gap-0 overflow-y-auto',
          side === 'bottom' ? 'max-h-[90dvh] rounded-t-xl pb-[env(safe-area-inset-bottom)]' : 'w-full sm:max-w-md',
        )}
      >
        <SheetHeader>
          <SheetTitle>Rides</SheetTitle>
          <SheetDescription>Download rides from the logger over Bluetooth, and open the ones saved here.</SheetDescription>
        </SheetHeader>

        {/* ---------- The logger ---------- */}
        <section className="flex flex-col gap-3 px-4 pb-4">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">On the logger</h3>
            {link && (
              <Badge variant="secondary" className="gap-1">
                <Bluetooth className="size-3" />
                {device}
              </Badge>
            )}
            <div className="ml-auto flex gap-1">
              {link ? (
                <>
                  <Button size="icon-sm" variant="ghost" onClick={() => refresh(link)} disabled={busy} aria-label="Refresh">
                    <RefreshCw className={cn(listing && 'animate-spin')} />
                  </Button>
                  <Button size="sm" variant="outline" onClick={disconnect}>
                    <BluetoothOff />
                    Disconnect
                  </Button>
                </>
              ) : (
                !scan && (
                  <Button size="sm" onClick={connect} disabled={connecting}>
                    {connecting ? <Loader2 className="animate-spin" /> : <Bluetooth />}
                    {connecting ? 'Connecting…' : remembered ? `Connect to ${remembered.name}` : 'Connect'}
                  </Button>
                )
              )}
            </div>
          </div>

          {!link && scan && (
            <ScanList scan={scan} onPick={(d) => connectTo(d)} onRescan={() => startScan()} onClose={closeScan} />
          )}

          {!link && !scan && !connecting && (
            <>
              <p className="text-sm text-muted-foreground">
                Turn on Bluetooth on the logger (Settings → Bluetooth), then connect. Rides can be read while the logger
                isn't recording.
              </p>
              {remembered && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <Button size="sm" variant="link" className="h-auto px-0" onClick={() => startScan()}>
                    Choose another logger
                  </Button>
                  <Button size="sm" variant="link" className="h-auto px-0 text-muted-foreground" onClick={forget}>
                    Forget {remembered.name}
                  </Button>
                </div>
              )}
            </>
          )}

          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

          {link && files && (
            <>
              {files.length === 0 ? (
                <p className="text-sm text-muted-foreground">No rides on the logger.</p>
              ) : (
                <ul className="flex flex-col divide-y rounded-lg border">
                  {files.map((f) => (
                    <li key={f.name}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/50">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={selected.has(f.name)}
                          onChange={() => toggle(f.name)}
                          disabled={busy}
                        />
                        <span className="font-medium tabular-nums">{f.name}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{fmtBytes(f.size)}</span>
                        {isSaved(f) && (
                          <Badge variant="outline" className="ml-auto gap-1 text-xs">
                            <Check className="size-3" />
                            Saved
                          </Badge>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
              )}

              {job ? (
                <JobProgress job={job} onCancel={job.kind === 'download' ? () => abortRef.current?.abort() : undefined} />
              ) : confirm?.kind === 'logger' ? (
                <div className="flex flex-col gap-2 rounded-lg border border-destructive/50 p-3 text-sm">
                  <p>
                    Delete {confirm.names.length === 1 ? confirm.names[0] : `${confirm.names.length} rides`} from the
                    logger?
                    {unsavedSelected > 0 && (
                      <strong className="text-destructive">
                        {' '}
                        {unsavedSelected === 1 ? 'One of them is' : `${unsavedSelected} of them are`} not saved in this
                        app and will be lost.
                      </strong>
                    )}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => removeFromLogger(confirm.names)}>
                      <Trash2 />
                      Delete
                    </Button>
                  </div>
                </div>
              ) : (
                files.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setSelected(selected.size === files.length ? new Set() : new Set(files.map((f) => f.name)))
                      }
                    >
                      {selected.size === files.length ? 'Select none' : 'Select all'}
                    </Button>
                    <div className="ml-auto flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={selectedNames.length === 0}
                        onClick={() => setConfirm({ kind: 'logger', names: selectedNames })}
                      >
                        <Trash2 />
                        Delete
                      </Button>
                      <Button size="sm" disabled={selectedNames.length === 0} onClick={() => download(selectedNames)}>
                        <Download />
                        Download{selectedNames.length > 0 && ` (${selectedNames.length})`}
                      </Button>
                    </div>
                  </div>
                )
              )}
            </>
          )}
        </section>

        <Separator />

        {/* ---------- Saved in the app ---------- */}
        <section className="flex flex-col gap-3 p-4">
          <h3 className="text-sm font-semibold">Saved in this app</h3>
          {saved.length === 0 ? (
            <p className="text-sm text-muted-foreground">Rides you download are kept here, also after you delete them from the logger.</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {saved.map((r) => (
                <li key={r.id} className="flex flex-col gap-2 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="flex min-w-0 flex-col">
                      <span className="font-medium tabular-nums">{r.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {r.startedAt ? fmtDate(r.startedAt) : 'No GPS date'} · {fmtBytes(r.size)} · {r.device}
                      </span>
                    </div>
                    <div className="ml-auto flex shrink-0 gap-1">
                      <Button size="sm" variant="outline" onClick={() => openSaved(r)} disabled={job !== null}>
                        <FolderOpen />
                        Open
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${r.name} from this app`}
                        onClick={() => setConfirm({ kind: 'saved', ride: r })}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  {confirm?.kind === 'saved' && confirm.ride.id === r.id && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-destructive">Delete from this app?</span>
                      <div className="ml-auto flex gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                          Cancel
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => removeSaved(r)}>
                          Delete
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </SheetContent>
    </Sheet>
  );
}

function SignalBars({ rssi }: { rssi: number | null }) {
  const [Icon, label] =
    rssi === null
      ? [Signal, 'Signal unknown']
      : rssi > -60
        ? [Signal, 'Excellent signal']
        : rssi > -70
          ? [SignalHigh, 'Good signal']
          : rssi > -80
            ? [SignalMedium, 'Fair signal']
            : [SignalLow, 'Weak signal'];
  return <Icon className="size-4 text-muted-foreground" aria-label={label} />;
}

function ScanList({
  scan,
  onPick,
  onRescan,
  onClose,
}: {
  scan: ScanState;
  onPick: (d: FoundLogger) => void;
  onRescan: () => void;
  onClose: () => void;
}) {
  // Strongest signal first: the logger next to you is the one you want.
  const found = [...scan.found].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      {scan.note && <p className="text-muted-foreground">{scan.note}</p>}
      <div className="flex items-center gap-2">
        {scan.scanning ? (
          <>
            <BluetoothSearching className="size-4 animate-pulse text-primary" />
            <span>Searching for loggers…</span>
          </>
        ) : (
          <span className="text-muted-foreground">
            {found.length === 0 ? 'No logger found. Is its Bluetooth on (Settings on the logger)?' : 'Pick a logger.'}
          </span>
        )}
        <div className="ml-auto flex gap-1">
          {!scan.scanning && (
            <Button size="icon-sm" variant="ghost" onClick={onRescan} aria-label="Search again">
              <RefreshCw />
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Cancel">
            <X />
          </Button>
        </div>
      </div>
      {found.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {found.map((d) => (
            <li key={d.deviceId}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent/50"
                onClick={() => onPick(d)}
              >
                <Bluetooth className="size-4 text-primary" />
                <span className="font-medium">{d.name}</span>
                <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                  {d.rssi !== null && `${d.rssi} dBm`}
                  <SignalBars rssi={d.rssi} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function JobProgress({ job, onCancel }: { job: Job; onCancel?: () => void }) {
  const p = job.kind === 'download' ? job.progress : null;
  const fraction = p && p.size ? p.received / p.size : 0;
  const left = p && p.rate > 0 ? Math.max(0, Math.round((p.size - p.received) / p.rate)) : null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <div className="flex items-center gap-2">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="min-w-0 truncate">
          {job.kind === 'download' ? 'Downloading' : 'Deleting'} {job.name}
          {job.total > 1 && (
            <span className="text-muted-foreground">
              {' '}
              ({job.index + 1} of {job.total})
            </span>
          )}
        </span>
        {onCancel && (
          <Button size="icon-sm" variant="ghost" className="ml-auto" onClick={onCancel} aria-label="Cancel">
            <X />
          </Button>
        )}
      </div>
      {job.kind === 'download' && (
        <>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-[width]" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {p ? `${fmtBytes(p.received)} of ${fmtBytes(p.size)}` : 'Starting…'}
            {p && p.rate > 0 && ` · ${(p.rate / 1024).toFixed(0)} KB/s`}
            {left !== null && ` · ${left} s left`}
          </span>
        </>
      )}
    </div>
  );
}
