import { useCallback, useEffect, useState } from "react";
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { isNotAuthorised } from "./http.ts";

// ---- navigation -----------------------------------------------------------------------------------
const NAVIGATE_EVENT = "gitsync:navigate";

export function navigate(href: string): void {
  history.pushState(null, "", href);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export function usePathname(): string {
  const [path, setPath] = useState(() => location.pathname + location.search);
  useEffect(() => {
    const update = () => setPath(location.pathname + location.search);
    window.addEventListener("popstate", update);
    window.addEventListener(NAVIGATE_EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(NAVIGATE_EVENT, update);
    };
  }, []);
  return path;
}

export function Link(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const { onClick, ...rest } = props;
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(props.href);
    window.scrollTo(0, 0);
  };
  return <a {...rest} onClick={click} />;
}

// ---- data loading ---------------------------------------------------------------------------------
export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload(): void;
  set(v: T): void;
}

export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ scope: readonly unknown[]; tick: number; data: T | null; error: unknown; loading: boolean }>(
    () => ({ scope: [...deps], tick, data: null, error: null, loading: true }));
  const matches = (candidate: { scope: readonly unknown[]; tick: number }) => candidate.tick === tick
    && candidate.scope.length === deps.length && deps.every((value, index) => Object.is(value, candidate.scope[index]));
  const current = matches(state);
  // Reset this hook's own state during render, before a changed workspace/view can render old private data.
  if (!current) setState({ scope: [...deps], tick, data: null, error: null, loading: true });
  useEffect(() => {
    let live = true;
    load().then(
      (data) => { if (live) setState((previous) => matches(previous) ? { ...previous, data, error: null, loading: false } : previous); },
      (error) => { if (live) setState((previous) => matches(previous) ? { ...previous, data: null, error, loading: false } : previous); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const set = useCallback((data: T) => setState((previous) => matches(previous)
    ? { ...previous, data, error: null, loading: false } : previous), [...deps, tick]);
  return { data: current ? state.data : null, error: current ? state.error : null, loading: current ? state.loading : true, reload, set };
}

// ---- presentation ---------------------------------------------------------------------------------
export function NotAuthorised({ what }: { what: string }) {
  return (
    <section className="panel panel-error" role="alert">
      <h2>Not authorised</h2>
      <p>{what} Sign in to Plane with an account that has the right access, then reload this page.</p>
    </section>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="error" role="alert">{error instanceof Error ? error.message : "Something went wrong"}</p>;
}

/** Renders loading, the not-authorised state, other errors, or the loaded data. */
export function Async<T>(props: { state: Loaded<T>; denied: string; children: (data: T) => ReactNode }) {
  const { state } = props;
  if (state.error) {
    return isNotAuthorised(state.error)
      ? <NotAuthorised what={props.denied} />
      : <section className="panel"><ErrorNote error={state.error} /><button type="button" onClick={state.reload}>Try again</button></section>;
  }
  if (state.data === null) return <p aria-busy="true">Loading…</p>;
  return <>{props.children(state.data)}</>;
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{props.label}</span>
      {props.children}
      {props.hint ? <span className="hint">{props.hint}</span> : null}
    </label>
  );
}

export interface Saver {
  busy: boolean;
  error: unknown;
  saved: boolean;
  run(fn: () => Promise<unknown>): Promise<boolean>;
  clear(): void;
}

/** Tracks one save action: busy flag, last error, and a "saved" confirmation. */
export function useSaver(): Saver {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null); setSaved(false);
    try {
      await fn();
      setSaved(true);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const clear = useCallback(() => { setError(null); setSaved(false); }, []);
  return { busy, error, saved, run, clear };
}

export function SaveStatus({ saver }: { saver: Saver }) {
  return (
    <div className="status" aria-live="polite">
      {saver.busy ? <span>Saving…</span> : null}
      {saver.saved && !saver.busy ? <span className="ok">Saved.</span> : null}
      {saver.error ? <ErrorNote error={saver.error} /> : null}
    </div>
  );
}

export function formatTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
