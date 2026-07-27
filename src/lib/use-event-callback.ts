import { useCallback, useLayoutEffect, useRef } from "react";

// A callback with a STABLE identity that always invokes the latest closure.
// Lets memoized children skip re-renders (identity never changes) without the
// stale-closure risk of useCallback([]) — the ref is refreshed every commit.
export function useEventCallback<Args extends unknown[], R>(
  fn: (...args: Args) => R,
): (...args: Args) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: Args) => ref.current(...args), []);
}
