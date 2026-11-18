import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Side-by-side layout: desktop, tablets, and phones held sideways. Otherwise the stacked phone layout. */
export const WIDE_LAYOUT_QUERY = '(min-width: 1024px), (orientation: landscape) and (min-width: 640px)';
