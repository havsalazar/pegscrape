import type { ReactNode } from 'react';
import { Pause, Play, RotateCcw, RotateCw, SkipBack } from 'lucide-react';
import { RATES, type Playback, type Rate } from '@/hooks/usePlayback';
import { fmtDuration } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function PlaybackControls({ pb, touch = false }: { pb: Playback; touch?: boolean }) {
  if (touch) return <TouchControls pb={pb} />;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex items-center gap-1">
        <IconButton label="Back to start (Home)" onClick={() => pb.seek(0)}>
          <SkipBack />
        </IconButton>
        <IconButton label="Back 10 s (←)" onClick={() => pb.skip(-10)}>
          <RotateCcw />
        </IconButton>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-lg" className="rounded-full" onClick={pb.toggle} aria-label={pb.playing ? 'Pause' : 'Play'}>
              {pb.playing ? <Pause className="size-5" /> : <Play className="size-5 translate-x-px" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{pb.playing ? 'Pause' : 'Play'} (Space)</TooltipContent>
        </Tooltip>
        <IconButton label="Forward 10 s (→)" onClick={() => pb.skip(10)}>
          <RotateCw />
        </IconButton>
      </div>

      <div className="text-sm tabular-nums">
        <span className="font-semibold">{fmtDuration(pb.time)}</span>
        <span className="text-muted-foreground"> / {fmtDuration(pb.duration)}</span>
      </div>

      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        className="ml-auto"
        value={String(pb.rate)}
        onValueChange={(v) => v && pb.setRate(Number(v) as Rate)}
        aria-label="Playback speed"
      >
        {RATES.map((r) => (
          <ToggleGroupItem key={r} value={String(r)} className="px-2 text-xs tabular-nums">
            {r}×
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/** Phone layout: one row of large (≥ 44 px) targets; speed is a single button that cycles. */
function TouchControls({ pb }: { pb: Playback }) {
  const nextRate = () => pb.setRate(RATES[(RATES.indexOf(pb.rate) + 1) % RATES.length]);
  return (
    <div className="flex items-center justify-between gap-1">
      <Button variant="ghost" className="size-11" onClick={() => pb.skip(-10)} aria-label="Back 10 seconds">
        <RotateCcw className="size-5" />
      </Button>
      <Button className="size-14 rounded-full" onClick={pb.toggle} aria-label={pb.playing ? 'Pause' : 'Play'}>
        {pb.playing ? <Pause className="size-6" /> : <Play className="size-6 translate-x-0.5" />}
      </Button>
      <Button variant="ghost" className="size-11" onClick={() => pb.skip(10)} aria-label="Forward 10 seconds">
        <RotateCw className="size-5" />
      </Button>
      <div className="min-w-0 flex-1 text-center text-sm tabular-nums">
        <span className="font-semibold">{fmtDuration(pb.time)}</span>
        <span className="text-muted-foreground"> / {fmtDuration(pb.duration)}</span>
      </div>
      <Button variant="outline" className="h-11 min-w-16 text-base tabular-nums" onClick={nextRate} aria-label={`Playback speed ${pb.rate}×, tap to change`}>
        {pb.rate}×
      </Button>
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
