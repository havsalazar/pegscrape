import { useCallback, useEffect, useRef, useState } from 'react';
import { type Ride, type Segment, timeOf } from '@/lib/ride';

export const RATES = [0.5, 1, 2, 4, 8, 16, 32] as const;
export type Rate = (typeof RATES)[number];

export interface Playback {
  /** Seconds since the start of the ride. */
  time: number;
  duration: number;
  playing: boolean;
  rate: Rate;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (time: number) => void;
  seekIndex: (index: number) => void;
  skip: (seconds: number) => void;
  setRate: (rate: Rate) => void;
  faster: () => void;
  slower: () => void;
  /** Jump over stationary stretches between riding segments while playing. */
  skipStops: boolean;
  setSkipStops: (v: boolean) => void;
  nextSegment: () => void;
  prevSegment: () => void;
}

/** Stops shorter than this are played normally even with skipStops on. */
const MIN_SKIP_S = 4;

export function usePlayback(ride: Ride | null): Playback {
  const duration = ride ? ride.stats.duration : 0;
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState<Rate>(1);
  const [skipStops, setSkipStops] = useState(false);
  const skipRef = useRef(false);
  skipRef.current = skipStops;
  const segments = ride?.segments ?? [];
  const segRef = useRef(segments);
  segRef.current = segments;

  const timeRef = useRef(0);
  const rateRef = useRef<Rate>(1);
  rateRef.current = rate;

  // Reset when a new ride is loaded.
  useEffect(() => {
    timeRef.current = 0;
    setTime(0);
    setPlaying(false);
  }, [ride]);

  useEffect(() => {
    if (!playing || !ride) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // Clamp dt so a backgrounded tab doesn't jump minutes ahead on return.
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      let next = timeRef.current + dt * rateRef.current;
      if (skipRef.current) next = skipGap(segRef.current, next, duration);
      if (next >= duration) {
        next = duration;
        setPlaying(false);
      }
      timeRef.current = next;
      setTime(next);
      if (next < duration) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, ride, duration]);

  const seek = useCallback(
    (t: number) => {
      const v = Math.max(0, Math.min(duration, t));
      timeRef.current = v;
      setTime(v);
    },
    [duration],
  );

  const seekIndex = useCallback((i: number) => ride && seek(timeOf(ride, i)), [ride, seek]);

  const play = useCallback(() => {
    if (!ride) return;
    if (timeRef.current >= duration) seek(0);
    setPlaying(true);
  }, [ride, duration, seek]);

  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, play, pause]);
  const skip = useCallback((s: number) => seek(timeRef.current + s), [seek]);

  const step = (dir: 1 | -1) =>
    setRate((r) => RATES[Math.max(0, Math.min(RATES.length - 1, RATES.indexOf(r) + dir))]);
  const faster = useCallback(() => step(1), []);
  const slower = useCallback(() => step(-1), []);

  // Segment navigation. A 1 s tolerance so pressing "previous" right after a jump goes one further back.
  const nextSegment = useCallback(() => {
    const s = segRef.current.find((x) => x.start > timeRef.current + 0.5);
    if (s) seek(s.start);
  }, [seek]);
  const prevSegment = useCallback(() => {
    const list = segRef.current;
    for (let k = list.length - 1; k >= 0; k--) {
      if (list[k].start < timeRef.current - 1) return seek(list[k].start);
    }
    seek(0);
  }, [seek]);

  return {
    time, duration, playing, rate, play, pause, toggle, seek, seekIndex, skip, setRate, faster, slower,
    skipStops, setSkipStops, nextSegment, prevSegment,
  };
}

/** If t is inside a stop longer than MIN_SKIP_S, move it to the start of the next segment. */
function skipGap(segments: Segment[], t: number, duration: number): number {
  if (!segments.length) return t;
  for (let k = 0; k < segments.length; k++) {
    const s = segments[k];
    if (t < s.start) {
      const prevEnd = k > 0 ? segments[k - 1].end : 0;
      return s.start - prevEnd >= MIN_SKIP_S ? s.start : t;
    }
    if (t <= s.end) return t;
  }
  // After the last segment: run to the end.
  const last = segments[segments.length - 1];
  return duration - last.end >= MIN_SKIP_S ? duration : t;
}
