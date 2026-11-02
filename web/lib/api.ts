"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
export const START_COMMAND = "./scripts/run.sh";

export class ApiError extends Error {
  status: number;
  /** True when the API could not be reached at all. */
  down: boolean;
  constructor(message: string, status: number, down = false) {
    super(message);
    this.status = status;
    this.down = down;
  }
}

/** FastAPI sends detail as text, or as a list of validation errors. */
export function detailText(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : String(d)));
    if (msgs.length) return msgs.join(" ");
  }
  return `The API answered with status ${status}.`;
}

const RETRY_DELAYS_MS = [400, 1200];

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

/**
 * A read that retries when the API fails it outright. The API's analysis queries share one database connection, which
 * refuses a second caller with a 500. That 500 carries no CORS header, so the browser reports it as a network failure.
 */
export async function read<T>(path: string, init?: RequestInit): Promise<T> {
  for (const delay of RETRY_DELAYS_MS) {
    try {
      return await request<T>(path, init);
    } catch (err) {
      const transient = err instanceof ApiError && (err.down || err.status >= 500);
      if (!transient) throw err;
      await wait(delay, init?.signal);
    }
  }
  return request<T>(path, init);
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(`The API at ${API_URL} cannot be reached.`, 0, true);
  }
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = (await res.json()).detail;
    } catch {
      detail = undefined;
    }
    throw new ApiError(detailText(detail, res.status), res.status);
  }
  return (await res.json()) as T;
}

export const post = <T,>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

/** Path segments are encoded one at a time. Source ids hold real slashes that the API route expects. */
export function conceptPath(model: string, source: string, index: number): string {
  return `/concepts/${encodeURIComponent(model)}/${source.split("/").map(encodeURIComponent).join("/")}/${index}`;
}

export function progressSocketUrl(forkId: string): string {
  return `${API_URL.replace(/^http/, "ws")}/forks/${encodeURIComponent(forkId)}/progress`;
}

/** Counts how many times the API has come back, so screens can refetch once it does. */
export const ApiEpoch = createContext(0);

export interface Fetched<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch on mount and whenever path changes. A null path fetches nothing. */
export function useFetch<T>(path: string | null, options?: { keepPrevious?: boolean }): Fetched<T> {
  const epoch = useContext(ApiEpoch);
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({
    data: null,
    error: null,
    loading: path !== null,
  });
  const [tick, setTick] = useState(0);
  const keep = useRef(options?.keepPrevious ?? false);

  useEffect(() => {
    if (path === null) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    const ctl = new AbortController();
    setState((s) => ({ data: keep.current ? s.data : null, error: null, loading: true }));
    read<T>(path, { signal: ctl.signal })
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        const e = err instanceof ApiError ? err : new ApiError(String((err as Error).message), 0);
        setState({ data: null, error: e, loading: false });
      });
    return () => ctl.abort();
  }, [path, tick, epoch]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Track an element's width, for charts drawn to exact pixels. */
export function useWidth<E extends HTMLElement>(initial = 600): [React.RefObject<E | null>, number] {
  const ref = useRef<E | null>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(Math.max(120, Math.round(el.getBoundingClientRect().width)));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
