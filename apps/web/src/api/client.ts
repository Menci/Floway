import { hc } from 'hono/client';

import { useAuthStore } from '../stores/auth.ts';
import type { AppType } from '@floway-dev/gateway/app-type';

const authFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const headers = new Headers(init?.headers);
  const token = useAuthStore().authToken;
  if (token) headers.set('x-floway-session', token);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) useAuthStore().clearAuth();
  return response;
};

export { authFetch };

const client = hc<AppType>('/', { fetch: authFetch });

export type ApiClient = typeof client;

export const useApi = (): ApiClient => client;

export interface GlobalError {
  status: number;
  message: string;
  raw?: unknown;
}

export type ApiResult<T> = { data: T; error?: undefined } | { data?: undefined; error: GlobalError };

// A 204 carries no body by definition (RFC 9110 §15.3.5), so there is nothing
// to parse and no data to hand back. The gateway answers `DELETE /api/aliases/
// :id` and `DELETE /api/proxies/:id` that way; parsing it as JSON turned a
// successful delete into "Unexpected end of JSON input", which the dashboard
// reported as a failed request while the row was already gone server-side.
//
// https://www.rfc-editor.org/rfc/rfc9110#section-15.3.5
const NO_CONTENT = 204;

export const callApi = async <T>(
  fn: () => Promise<Response>,
): Promise<ApiResult<T>> => {
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
    } catch { /* non-JSON body */ }
    let message = `HTTP ${response.status}`;
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      if (typeof obj.error === 'string') message = obj.error;
      else if (obj.error && typeof obj.error === 'object' && typeof (obj.error as Record<string, unknown>).message === 'string') {
        message = (obj.error as { message: string }).message;
      }
    }
    return { error: { status: response.status, message, raw: body } };
  }

  // Callers of a body-less route read `error` and ignore `data`; typing the
  // absent body as `T` keeps the result shape uniform for everyone else.
  if (response.status === NO_CONTENT) return { data: undefined as T };

  let data: T;
  try {
    data = (await response.json()) as T;
  } catch (e: unknown) {
    return { error: { status: response.status, message: e instanceof Error ? e.message : 'Invalid JSON response' } };
  }
  return { data };
};
