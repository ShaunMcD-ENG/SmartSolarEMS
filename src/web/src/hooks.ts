import { useEffect, useRef, useState } from "react";
import { apiErrorMessage } from "./api";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Runs `fetcher` once per dependency change, and optionally again every
 * `intervalMs` (pass 0 to disable polling). `loading` is only true for the
 * very first fetch of a given dependency set — subsequent polls update
 * silently in the background so the UI doesn't flash a spinner every 10s.
 */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number, deps: unknown[] = []): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));

    async function run() {
      try {
        const data = await fetcherRef.current();
        if (!cancelled) setState({ data, loading: false, error: null });
      } catch (err) {
        if (!cancelled) setState((s) => ({ data: s.data, loading: false, error: apiErrorMessage(err) }));
      }
    }

    run();
    if (intervalMs > 0) {
      const id = setInterval(run, intervalMs);
      return () => {
        cancelled = true;
        clearInterval(id);
      };
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

/** One-shot fetch (no polling) with a manual `reload()` escape hatch. */
export function useAsync<T>(fetcher: () => Promise<T>, deps: unknown[] = []): AsyncState<T> & { reload: () => void } {
  const [tick, setTick] = useState(0);
  const state = usePoll(fetcher, 0, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
