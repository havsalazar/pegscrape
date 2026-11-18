import { memo } from 'react';
import bikeUrl from '@/assets/bike-back-view.png';
import { cn } from '@/lib/utils';

// Geometry (SVG user units). The bike rotates around the tyre contact patch (PX, PY).
const W = 400;
const H = 270;
const PX = W / 2;
const PY = 250;
const BIKE_H = 215;
const BIKE_W = (BIKE_H * 278) / 599; // keep the PNG's aspect ratio
const ARC_R = 222;
const MAX_VISUAL = 90;

/** Colour by lean magnitude: green -> yellow -> orange -> red. */
export function leanColor(absDeg: number): string {
  if (absDeg < 20) return 'oklch(0.75 0.17 150)';
  if (absDeg < 35) return 'oklch(0.85 0.17 95)';
  if (absDeg < 45) return 'oklch(0.75 0.18 55)';
  return 'oklch(0.65 0.23 25)';
}

function polar(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [PX + r * Math.sin(a), PY - r * Math.cos(a)];
}

function wedgePath(deg: number, r: number): string {
  const [x0, y0] = polar(0, r);
  const [x1, y1] = polar(deg, r);
  const sweep = deg > 0 ? 1 : 0;
  const large = Math.abs(deg) > 180 ? 1 : 0;
  return `M ${PX} ${PY} L ${x0} ${y0} A ${r} ${r} 0 ${large} ${sweep} ${x1} ${y1} Z`;
}

interface Props {
  lean: number;
  peakLeft: number;
  peakRight: number;
  className?: string;
}

export const BikeLean = memo(function BikeLean({ lean, peakLeft, peakRight, className }: Props) {
  const visual = Math.max(-MAX_VISUAL, Math.min(MAX_VISUAL, lean));
  const color = leanColor(Math.abs(lean));

  const ticks = [];
  for (let d = -80; d <= 80; d += 10) {
    const major = d % 30 === 0;
    const [x1, y1] = polar(d, ARC_R - (major ? 14 : 8));
    const [x2, y2] = polar(d, ARC_R);
    ticks.push(
      <line
        key={d}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="currentColor"
        strokeOpacity={major ? 0.55 : 0.25}
        strokeWidth={major ? 2 : 1.25}
      />,
    );
    if (major && d !== 0) {
      const [lx, ly] = polar(d, ARC_R - 28);
      ticks.push(
        <text
          key={`l${d}`}
          x={lx}
          y={ly}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={13}
          fill="currentColor"
          fillOpacity={0.5}
        >
          {Math.abs(d)}°
        </text>,
      );
    }
  }

  const peak = (deg: number, cls: string) => {
    if (Math.abs(deg) < 1) return null;
    const v = Math.max(-MAX_VISUAL, Math.min(MAX_VISUAL, deg));
    const [x1, y1] = polar(v, ARC_R - 4);
    const [x2, y2] = polar(v, ARC_R + 10);
    return <line x1={x1} y1={y1} x2={x2} y2={y2} className={cls} stroke="currentColor" strokeWidth={4} strokeLinecap="round" />;
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn('w-full select-none', className)} role="img" aria-label={`Lean ${lean.toFixed(1)} degrees`}>
      {/* lean wedge */}
      <path d={wedgePath(visual, ARC_R)} fill={color} fillOpacity={0.14} />
      {/* scale */}
      <path
        d={`M ${polar(-85, ARC_R).join(' ')} A ${ARC_R} ${ARC_R} 0 0 1 ${polar(85, ARC_R).join(' ')}`}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.2}
        strokeWidth={1.5}
      />
      {ticks}
      {/* session peaks so far */}
      {peak(peakLeft, 'text-lean-left')}
      {peak(peakRight, 'text-lean-right')}
      {/* centre line */}
      <line x1={PX} y1={PY} x2={PX} y2={PY - ARC_R} stroke="currentColor" strokeOpacity={0.15} strokeDasharray="4 6" />
      {/* bike */}
      <g transform={`rotate(${visual} ${PX} ${PY})`}>
        <line x1={PX} y1={PY} x2={PX} y2={PY - ARC_R} stroke={color} strokeWidth={2} strokeOpacity={0.9} />
        <image
          href={bikeUrl}
          x={PX - BIKE_W / 2}
          y={PY - BIKE_H}
          width={BIKE_W}
          height={BIKE_H}
          className="dark:invert"
          preserveAspectRatio="xMidYMax meet"
        />
      </g>
      {/* ground */}
      <line x1={20} y1={PY + 1} x2={W - 20} y2={PY + 1} stroke="currentColor" strokeOpacity={0.4} strokeWidth={2} />
    </svg>
  );
});
