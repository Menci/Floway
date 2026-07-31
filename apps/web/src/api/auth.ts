import {
  flowaySessionHeader,
  getSessionToken,
  invalidateSession,
} from '../auth/session';
import { errorMessage } from '../lib/error-message';

export interface AuthUser {
  id: number;
  username: string;
  isAdmin: boolean;
  upstreamIds: string[] | null;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface MeResponse {
  user: AuthUser;
  viaApiKey: boolean;
  apiKey: { id: string; name: string } | null;
}

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
  } catch (error: unknown) {
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
        message: errorMessageFromBody(body) ?? `HTTP ${response.status}`,
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
  } catch (error: unknown) {
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

const errorMessageFromBody = (body: unknown): string | null => {
  if (!body || typeof body !== 'object') return null;

  const record = body as Record<string, unknown>;
  if (typeof record.error === 'string') return record.error;
  if (
    record.error &&
    typeof record.error === 'object' &&
    typeof (record.error as Record<string, unknown>).message === 'string'
  ) {
    return (record.error as { message: string }).message;
  }

  return null;
};
