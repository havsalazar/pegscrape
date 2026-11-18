import { Satellite, SatelliteDish } from 'lucide-react';
import type { Frame } from '@/lib/ride';
import { fmtClock, fmtG, fmtLean, leanSide } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { leanColor } from '@/components/BikeLean';

const G_RANGE = 1.2;

export function LeanReadout({ lean, compact = false }: { lean: number; compact?: boolean }) {
  const side = leanSide(lean);
  const sideCls = compact ? 'w-4 text-base font-semibold' : 'w-6 text-lg font-semibold';
  return (
    <div className="flex items-baseline justify-center gap-1.5">
      <span className={cn(sideCls, 'text-right', side === 'L' ? 'text-lean-left' : 'text-transparent')}>L</span>
      <span
        className={cn(
          'min-w-[5ch] text-center font-bold tabular-nums tracking-tight',
          compact ? 'text-3xl' : 'text-4xl lg:text-5xl',
        )}
        style={{ color: leanColor(Math.abs(lean)) }}
      >
        {fmtLean(lean)}
      </span>
      <span className={cn(sideCls, side === 'R' ? 'text-lean-right' : 'text-transparent')}>R</span>
    </div>
  );
}

/** Phone layout: lean, speed, g and GPS stacked in a narrow column next to the bike. */
export function CompactTelemetry({ frame }: { frame: Frame }) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <LeanReadout lean={frame.lean} compact />
      <div className="flex items-baseline justify-center gap-1">
        <span className="text-3xl font-bold tabular-nums leading-none">{Math.round(frame.speed)}</span>
        <span className="text-xs text-muted-foreground">km/h</span>
      </div>
      <GMeter accel={frame.accel} />
      <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
        {frame.fix ? <Satellite className="size-3" /> : <SatelliteDish className="size-3 text-destructive" />}
        <span className={cn(!frame.fix && 'text-destructive')}>{frame.fix ? `${frame.sats < 0 ? '—' : frame.sats} sats` : 'No fix'}</span>
        <span>·</span>
        <span>{fmtClock(frame.epochMs)}</span>
      </div>
    </div>
  );
}

export function GMeter({ accel }: { accel: number }) {
  const u = Math.max(-1, Math.min(1, accel / G_RANGE));
  const braking = accel <= -0.1;
  const accelerating = accel >= 0.1;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Brake</span>
        <span
          className={cn(
            'text-sm font-semibold tabular-nums',
            braking ? 'text-brake' : accelerating ? 'text-throttle' : 'text-foreground',
          )}
        >
          {fmtG(accel)}
        </span>
        <span>Accel</span>
      </div>
      <div className="relative h-3 overflow-hidden rounded-full bg-muted">
        <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/40" />
        <div
          className={cn('absolute inset-y-0', u < 0 ? 'bg-brake' : 'bg-throttle')}
          style={u < 0 ? { right: '50%', width: `${-u * 50}%` } : { left: '50%', width: `${u * 50}%` }}
        />
      </div>
    </div>
  );
}

export function TelemetryRow({ frame }: { frame: Frame }) {
  const state = frame.accel <= -0.1 ? 'BRK' : frame.accel >= 0.1 ? 'ACC' : null;
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-5 gap-y-3">
      <div className="flex flex-col">
        <span className="text-4xl font-bold tabular-nums leading-none">{Math.round(frame.speed)}</span>
        <span className="text-xs text-muted-foreground">km/h</span>
      </div>
      <GMeter accel={frame.accel} />
      <div className="col-span-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {state && (
          <Badge className={cn('text-white', state === 'BRK' ? 'bg-brake' : 'bg-throttle')}>{state}</Badge>
        )}
        <Badge variant="outline" className={cn(!frame.fix && 'border-destructive text-destructive')}>
          {frame.fix ? <Satellite /> : <SatelliteDish />}
          {frame.fix ? 'GPS fix' : 'No fix'} · {frame.sats < 0 ? '—' : frame.sats} sats
        </Badge>
        <span className="ml-auto tabular-nums" title="Local time (UTC in brackets)">
          {fmtClock(frame.epochMs)} <span className="opacity-60">({fmtClock(frame.epochMs, true)} UTC)</span>
        </span>
      </div>
    </div>
  );
}
