export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtClock(epochMs: number, utc = false): string {
  if (!Number.isFinite(epochMs)) return '--:--:--';
  const d = new Date(epochMs);
  const p = (v: number) => String(v).padStart(2, '0');
  return utc
    ? `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    : `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function fmtDate(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '';
  return new Date(epochMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtLean(deg: number): string {
  return `${Math.abs(deg).toFixed(1)}°`;
}

export function leanSide(deg: number): 'L' | 'R' | '' {
  if (deg <= -0.5) return 'L';
  if (deg >= 0.5) return 'R';
  return '';
}

export function fmtG(g: number): string {
  return `${g >= 0 ? '+' : '−'}${Math.abs(g).toFixed(2)} g`;
}
