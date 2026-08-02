import { hc } from 'hono/client';

import {
  flowaySessionHeader,
  getSessionToken,
  invalidateSession,
} from '../auth/session';
import { errorMessage } from '../lib/error-message';
import { errorMessageFromPayload } from '../lib/error-payload';
import type { AppType } from '@floway-dev/gateway/app-type';

export interface GlobalError<TRaw = unknown> {
  status: number;
  message: string;
  raw?: TRaw;
}

export type ApiResult<T, TRaw = unknown> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: GlobalError<TRaw> };

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

// hc types the request only; callApi below still owns the { error } envelope,
// non-JSON bodies and the single 401 path.
export const api = hc<AppType>('/', { fetch: authFetch });

type SuccessfulJson<TResponse extends Response> = TResponse extends {
  status: infer Status;
  json(): Promise<infer Body>;
}
  ? Status extends number
    ? `${Status}` extends `2${string}` ? Body : never
    : never
  : never;

// The gateway declares its failure bodies as precisely as its success bodies, so
// a caller reads a conflict payload at the type the route states rather than
// asserting a shape onto `unknown`.
type FailedJson<TResponse extends Response> = TResponse extends {
  status: infer Status;
  json(): Promise<infer Body>;
}
  ? Status extends number
    ? `${Status}` extends `2${string}` ? never : Body
    : never
  : never;

// The network, the 401 path and a failed status all resolve here, so the two
// callers below differ only in whether they parse.
const requestResponse = async <TRaw>(
  fn: () => Promise<Response>,
): Promise<ApiResult<Response, TRaw>> => {
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
        // The route union says what a failure carries; this is where an untyped
        // parse result adopts it.
        raw: body as TRaw,
      },
    };
  }

  return { data: response };
};

const callResponse = async <T, TRaw>(fn: () => Promise<Response>): Promise<ApiResult<T, TRaw>> => {
  const result = await requestResponse<TRaw>(fn);
  if (result.error) return result;

  try {
    return { data: (await result.data.json()) as T };
  } catch (error) {
    return {
      error: {
        status: result.data.status,
        message: errorMessage(error),
      },
    };
  }
};

export const callApi = <TResponse extends Response>(
  fn: () => Promise<TResponse>,
): Promise<ApiResult<SuccessfulJson<TResponse>, FailedJson<TResponse>>> =>
  callResponse<SuccessfulJson<TResponse>, FailedJson<TResponse>>(fn);

// A 204 carries no body at all, so success is the absence of an error and
// nothing is parsed. Asking for the JSON would turn one into a parse failure.
// https://www.rfc-editor.org/rfc/rfc9110#section-15.3.5
export const callApiNoContent = async <TResponse extends Response>(
  fn: () => Promise<TResponse>,
): Promise<ApiResult<void, FailedJson<TResponse>>> => {
  const { error } = await requestResponse<FailedJson<TResponse>>(fn);
  return error ? { error } : { data: undefined };
};
