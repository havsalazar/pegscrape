import { useEffect, useState } from 'react';
import { HardDriveDownload, Trash2 } from 'lucide-react';
import { cacheStats, clearCache, onCacheChange, MAX_TILES, type CacheStats } from '@/lib/tileCache';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function fmtBytes(b: number): string {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

/** Shows how much of the map is saved for offline use, with a button to clear it. */
export function MapCacheCard() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = () => void cacheStats().then((s) => alive && setStats(s));
    refresh();
    const off = onCacheChange(refresh);
    return () => {
      alive = false;
      off();
    };
  }, []);

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <HardDriveDownload className="size-4" /> Offline map
        </CardTitle>
        <CardDescription className="text-xs">
          Map tiles you view while online are saved, so those areas work without a connection.
        </CardDescription>
        <CardAction>
          <Button
            size="sm"
            variant={confirming ? 'destructive' : 'ghost'}
            disabled={!stats?.tiles}
            onClick={() => {
              if (!confirming) {
                setConfirming(true);
                setTimeout(() => setConfirming(false), 3000);
                return;
              }
              setConfirming(false);
              void clearCache();
            }}
          >
            <Trash2 /> {confirming ? 'Confirm' : 'Clear'}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-4 text-sm tabular-nums">
        {stats ? (
          <>
            <span className="font-semibold">{stats.tiles.toLocaleString()}</span> tiles ·{' '}
            <span className="font-semibold">{fmtBytes(stats.bytes)}</span>
            <span className="text-muted-foreground"> (max {MAX_TILES.toLocaleString()} tiles, oldest dropped first)</span>
          </>
        ) : (
          <span className="text-muted-foreground">Checking…</span>
        )}
      </CardContent>
    </Card>
  );
}
