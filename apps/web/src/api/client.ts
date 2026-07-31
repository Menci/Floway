import { hc } from 'hono/client';

import {
  flowaySessionHeader,
  getSessionToken,
  invalidateSession,
} from '../auth/session';
import { errorMessage } from '../lib/error-message';
import { errorMessageFromPayload } from '../lib/error-payload';
import type { AppType } from '@floway-dev/gateway/app-type';

export interface GlobalError {
  status: number;
  message: string;
  raw?: unknown;
}

export type ApiResult<T> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: GlobalError };

export const authFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const headers = new Headers(init?.headers);
  const token = getSessionToken();
  if (token) headers.set(flowaySessionHeader, token);

  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) {
    invalidateSession(token);
  }
  return response;
};

// hc types the request — path, method and body come from the gateway's own
// route definitions, so a control-plane change breaks typecheck here instead
// of at runtime. It does not unwrap the response; callApi below still owns the
// { error } envelope, non-JSON bodies and the single 401 path.
export const api = hc<AppType>('/', { fetch: authFetch });

type SuccessfulJson<TResponse extends Response> = TResponse extends {
  status: infer Status;
  json(): Promise<infer Body>;
}
  ? Status extends number
    ? `${Status}` extends `2${string}` ? Body : never
    : never
  : never;

// Everything up to the body: the network, the 401 path and a failed status all
// resolve here, so the two callers below differ only in whether they parse.
const requestResponse = async (
  fn: () => Promise<Response>,
): Promise<ApiResult<Response>> => {
  let response: Response;
  try {
    response = await fn();
  } catch (error) {
    return {
      error: {
        status: 0,
        message: errorMessage(error),
      },
    };
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // Non-JSON error responses fall back to the HTTP status.
    }

    return {
      error: {
        status: response.status,
        message: errorMessageFromPayload(body) ?? `HTTP ${response.status}`,
        raw: body,
      },
    };
  }

  return { data: response };
};

const callResponse = async <T>(fn: () => Promise<Response>): Promise<ApiResult<T>> => {
  const result = await requestResponse(fn);
  if (result.error) return result;

  try {
    return { data: (await result.data.json()) as T };
  } catch (error) {
    return {
      error: {
        status: result.data.status,
        message:
          error instanceof Error ? error.message : 'Invalid JSON response',
      },
    };
  }
};

export const callApi = <TResponse extends Response>(
  fn: () => Promise<TResponse>,
): Promise<ApiResult<SuccessfulJson<TResponse>>> =>
  callResponse<SuccessfulJson<TResponse>>(fn);

// A 204 carries no body at all, so success is the absence of an error and
// nothing is parsed. Asking for the JSON would turn one into a parse failure.
// https://www.rfc-editor.org/rfc/rfc9110#section-15.3.5
export const callApiNoContent = async (fn: () => Promise<Response>): Promise<ApiResult<void>> => {
  const { error } = await requestResponse(fn);
  return error ? { error } : { data: undefined };
};
