import type { ApiErrorBody, ErrorCode } from '@app/shared';
import { idleHeader } from './activity';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  /** Field errors keyed by path (from VALIDATION_FAILED details). */
  fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    const out: Record<string, string> = {};
    for (const d of this.details as { path?: string; message?: string }[]) {
      if (d.path && d.message && !out[d.path]) out[d.path] = d.message;
    }
    return out;
  }
}

const BASE = '/api/v1';
const CSRF_COOKIE = 'csrf_token';

function readCookie(name: string): string | null {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

let csrfPromise: Promise<string> | null = null;
async function csrfToken(): Promise<string> {
  const existing = readCookie(CSRF_COOKIE);
  if (existing) return existing;
  csrfPromise ??= fetch(`${BASE}/auth/csrf`, { credentials: 'same-origin' })
    .then((r) => r.json() as Promise<{ token: string }>)
    .then((b) => b.token)
    .finally(() => {
      csrfPromise = null;
    });
  return csrfPromise;
}

function idleHeaders(): Record<string, string> {
  const idle = idleHeader();
  return idle === undefined ? {} : { 'x-idle-ms': idle };
}

let refreshPromise: Promise<boolean> | null = null;
/** Single-flight refresh: concurrent 401s share one refresh request. */
function refreshSession(): Promise<boolean> {
  refreshPromise ??= (async () => {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': await csrfToken(), ...idleHeaders() },
    });
    return res.ok;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

type Listener = () => void;
const unauthenticatedListeners = new Set<Listener>();
export const onUnauthenticated = (fn: Listener) => {
  unauthenticatedListeners.add(fn);
  return () => unauthenticatedListeners.delete(fn);
};

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Skip the refresh-and-retry dance (auth endpoints). */
  noRetry?: boolean;
}

export function buildUrl(path: string, query?: RequestOptions['query']) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.pathname + url.search;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const isForm = opts.body instanceof FormData;
  const headers: Record<string, string> = { Accept: 'application/json', ...idleHeaders() };
  if (method !== 'GET') headers['x-csrf-token'] = await csrfToken();
  if (opts.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      credentials: 'same-origin',
      signal: opts.signal,
      body:
        opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
  }

  if (res.status === 401 && !opts.noRetry) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as ApiErrorBody | null;
    if (body?.error.code === 'TOKEN_EXPIRED' || body?.error.code === 'UNAUTHENTICATED') {
      if (await refreshSession()) return api<T>(path, { ...opts, noRetry: true });
      unauthenticatedListeners.forEach((fn) => fn());
    }
  }
  if (res.status === 403) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as ApiErrorBody | null;
    if (body?.error.code === 'CSRF_INVALID' && !opts.noRetry) {
      document.cookie = `${CSRF_COOKIE}=; Max-Age=0; path=/`;
      return api<T>(path, { ...opts, noRetry: true });
    }
  }

  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = (data as ApiErrorBody)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'INTERNAL',
      err?.message ?? 'Something went wrong',
      err?.details,
    );
  }
  return data as T;
}

export const apiGet = <T>(path: string, query?: RequestOptions['query']) => api<T>(path, { query });
export const apiPost = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body ?? {} });
export const apiPatch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const apiPut = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const apiDelete = <T>(path: string) => api<T>(path, { method: 'DELETE' });
