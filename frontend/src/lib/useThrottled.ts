import { useEffect, useRef, useState } from "react";

// Returns a snapshot of `value` that updates at most every `ms` milliseconds.
// Uses a ref + a single, stable interval so the timer isn't reset on every
// upstream change (previously the timer never fired because `value` ticked
// faster than `ms`).
export function useThrottled<T>(value: T, ms: number): T {
  const [snap, setSnap] = useState<T>(value);
  const latest = useRef<T>(value);
  latest.current = value;

  useEffect(() => {
    const id = window.setInterval(() => {
      setSnap(latest.current);
    }, ms);
    return () => window.clearInterval(id);
  }, [ms]);

  return snap;
}
