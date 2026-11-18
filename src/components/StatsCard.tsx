import { CornerDownRight } from 'lucide-react';
import type { Extreme, Ride } from '@/lib/ride';
import { MOVING_KMH } from '@/lib/ride';
import { fmtDuration, fmtG } from '@/lib/format';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface Props {
  ride: Ride;
  onJump: (index: number) => void;
}

export function StatsCard({ ride, onJump }: Props) {
  const s = ride.stats;
  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Ride summary</CardTitle>
        <CardDescription className="text-xs">
          Peaks count only while moving (≥ {MOVING_KMH} km/h). Click a peak to jump to it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 px-4">
        <Stat label="Duration" value={fmtDuration(s.duration)} />
        <Stat label="Moving" value={fmtDuration(s.movingTime)} />
        <Stat label="Distance" value={`${s.distanceKm.toFixed(2)} km`} />
        <Stat label="Avg moving" value={`${s.avgMovingSpeed.toFixed(0)} km/h`} />
        <Peak label="Max lean left" value={`${Math.abs(s.maxLeanLeft.value).toFixed(1)}°`} e={s.maxLeanLeft} onJump={onJump} className="text-lean-left" />
        <Peak label="Max lean right" value={`${s.maxLeanRight.value.toFixed(1)}°`} e={s.maxLeanRight} onJump={onJump} className="text-lean-right" />
        <Peak label="Top speed" value={`${s.maxSpeed.value.toFixed(0)} km/h`} e={s.maxSpeed} onJump={onJump} />
        <Peak label="Hardest braking" value={fmtG(s.maxBrake.value)} e={s.maxBrake} onJump={onJump} className="text-brake" />
        <Peak label="Hardest accel" value={fmtG(s.maxAccel.value)} e={s.maxAccel} onJump={onJump} className="text-throttle" />
        <Stat label="GPS" value={`${(100 - s.noFixPct).toFixed(1)}% fix · ${s.maxSats} sats`} />
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Peak({
  label,
  value,
  e,
  onJump,
  className,
}: {
  label: string;
  value: string;
  e: Extreme;
  onJump: (i: number) => void;
  className?: string;
}) {
  const empty = e.value === 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={empty}
          onClick={() => onJump(e.index)}
          className="group rounded-md bg-muted/40 px-3 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
        >
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            {label}
            <CornerDownRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          <div className={cn('text-sm font-semibold tabular-nums', className)}>{value}</div>
        </button>
      </TooltipTrigger>
      {!empty && <TooltipContent>Jump to this moment</TooltipContent>}
    </Tooltip>
  );
}
