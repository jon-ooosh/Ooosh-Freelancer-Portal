/**
 * True on a phone-width screen (under Tailwind's `sm`, 640px), kept live as the window
 * is resized or the phone turned. For layouts that need a DIFFERENT shape on a phone
 * (a list instead of a month grid) — plain responsive classes are still the first choice
 * when only sizes or columns change.
 */
import { useEffect, useState } from 'react';

const QUERY = '(max-width: 639px)';

function matches(): boolean {
  try { return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(QUERY).matches; }
  catch { return false; }
}

export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(matches);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setIsPhone(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isPhone;
}
