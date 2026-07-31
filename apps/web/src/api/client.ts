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

const runRequest = async (fn: () => Promise<Response>): Promise<ApiResult<Response>> => {
  let response: Response;
  try {
    response = await fn();
  } catch (e: unknown) {
    return { error: { status: 0, message: e instanceof Error ? e.message : String(e) } };
  }

  if (response.ok) return { data: response };

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
};

export const callApi = async <T>(
  fn: () => Promise<Response>,
): Promise<ApiResult<T>> => {
  const result = await runRequest(fn);
  if (result.error) return result;

  let data: T;
  try {
    data = (await result.data.json()) as T;
  } catch (e: unknown) {
    return { error: { status: result.data.status, message: e instanceof Error ? e.message : 'Invalid JSON response' } };
  }
  return { data };
};

// For a route that answers 204, which carries no body at all
// (https://www.rfc-editor.org/rfc/rfc9110#section-15.3.5): success is the
// absence of an error, and nothing is parsed.
export const callApiNoContent = async (
  fn: () => Promise<Response>,
): Promise<ApiResult<void>> => {
  const { error } = await runRequest(fn);
  return error ? { error } : { data: undefined };
};
