import { Bluetooth, FileUp } from 'lucide-react';
import bikeUrl from '@/assets/bike-back-view.png';
import type { LoadProgress } from '@/lib/loadRide';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ProgressRing } from '@/components/ProgressRing';

interface Props {
  onPick: () => void;
  /** Open the rides panel: the logger over Bluetooth and the rides saved in the app. */
  onRides: () => void;
  progress: LoadProgress | null;
  error: string | null;
  dragging: boolean;
}

export const STAGE_LABEL = { reading: 'Reading file…', parsing: 'Processing ride…' } as const;

export function OpenRide({ onPick, onRides, progress, error, dragging }: Props) {
  return (
    <div className="flex size-full items-center justify-center p-4">
      <Card
        className={
          'w-full max-w-md items-center gap-5 border-dashed px-6 py-10 text-center transition-colors ' +
          (dragging ? 'border-primary bg-accent' : '')
        }
      >
        {progress ? (
          <ProgressRing value={progress.fraction} size={120} label={STAGE_LABEL[progress.stage]} className="py-6" />
        ) : (
          <>
            <img src={bikeUrl} alt="" className="h-36 opacity-90 dark:invert" draggable={false} />
            <CardContent className="flex flex-col items-center gap-2 px-0">
              <h1 className="text-xl font-semibold">Open a ride log</h1>
              <p className="text-sm text-muted-foreground">
                Download rides from the logger over Bluetooth, or pick a{' '}
                <code className="rounded bg-muted px-1">RIDExxxx.CSV</code> from its SD card
                <span className="hidden md:inline"> (or drop it anywhere in this window)</span>.
              </p>
            </CardContent>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="lg" onClick={onRides}>
                <Bluetooth />
                Rides from the logger
              </Button>
              <Button size="lg" variant="outline" onClick={onPick}>
                <FileUp />
                Choose CSV file
              </Button>
            </div>
          </>
        )}
        {error && <p className="max-w-sm text-sm text-destructive">{error}</p>}
      </Card>
    </div>
  );
}
