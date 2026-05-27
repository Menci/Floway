import { hc } from 'hono/client';

import { useAuthStore } from '../stores/auth.ts';
import type { AppType } from '@floway-dev/api/app-type';

// Inject the live x-api-key on every outbound request and short-circuit the
// store on 401 so the router guard can redirect to /login.
const authFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const headers = new Headers(init?.headers ?? {});
  const key = useAuthStore().authKey;
  if (key) headers.set('x-api-key', key);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) useAuthStore().clearAuth();
  return response;
};

// The Hono RPC proxy. Every control-plane route declares its request shape via
// zValidator in apps/api/src/control-plane/routes.ts, so the proxy types both
// the path/method and the JSON body / query for the SPA — no extra wrapper
// needed for mutations.
const client = hc<AppType>('/', { fetch: authFetch });

export type ApiClient = typeof client;

export const useApi = (): ApiClient => client;

export interface GlobalError {
  status: number;
  message: string;
  raw?: unknown;
}

// Unwrap a Hono RPC response into a Marina-shaped `{ data?, error? }`. The
// generic is supplied by the caller because the Hono RPC proxy types
// `.json()` per-handler but we lose that narrowing when wrapping in a helper.
export const callApi = async <T>(
  fn: () => Promise<Response>,
): Promise<{ data?: T; error?: GlobalError }> => {
  let response: Response;
  try {
    response = await fn();
  } catch (e: unknown) {
    return { error: { status: 0, message: e instanceof Error ? e.message : String(e) } };
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // Non-JSON error bodies (e.g. upstream HTML errors) — leave body undefined.
    }
    const message = extractErrorMessage(body, response.status);
    return { error: { status: response.status, message, raw: body } };
  }

  let data: T;
  try {
    data = (await response.json()) as T;
  } catch (e: unknown) {
    return { error: { status: response.status, message: e instanceof Error ? e.message : 'Invalid JSON response' } };
  }
  return { data };
};

const extractErrorMessage = (body: unknown, status: number): string => {
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (typeof obj.error === 'string') return obj.error;
    if (obj.error && typeof obj.error === 'object' && typeof (obj.error as Record<string, unknown>).message === 'string') {
      return (obj.error as { message: string }).message;
    }
  }
  return `HTTP ${status}`;
};
