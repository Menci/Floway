import {
  clearSessionToken,
  flowaySessionHeader,
  getSessionToken,
} from "../auth/session";

export interface AuthUser {
  id: number;
  username: string;
  isAdmin: boolean;
  canViewGlobalTelemetry: boolean;
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
    clearSessionToken();
  }
  return response;
};

export const callApi = async <T>(
  fn: () => Promise<Response>,
): Promise<ApiResult<T>> => {
  let response: Response;
  try {
    response = await fn();
  } catch (error: unknown) {
    return {
      error: {
        status: 0,
        message: error instanceof Error ? error.message : String(error),
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

  try {
    return { data: (await response.json()) as T };
  } catch (error: unknown) {
    return {
      error: {
        status: response.status,
        message:
          error instanceof Error ? error.message : "Invalid JSON response",
      },
    };
  }
};

export const login = (body: {
  username: string;
  password: string;
}): Promise<ApiResult<LoginResponse>> =>
  callApi<LoginResponse>(() =>
    fetch("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

export const getCurrentSession = (): Promise<ApiResult<MeResponse>> =>
  callApi<MeResponse>(() => authFetch("/auth/me"));

// Mirrors PATCH /api/users/me/password in the Floway control plane.
export const changeOwnPassword = (body: {
  currentPassword: string;
  newPassword: string;
}): Promise<ApiResult<{ ok: true }>> =>
  callApi<{ ok: true }>(() =>
    authFetch("/api/users/me/password", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const errorMessageFromBody = (body: unknown): string | null => {
  if (!body || typeof body !== "object") return null;

  const record = body as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (
    record.error &&
    typeof record.error === "object" &&
    typeof (record.error as Record<string, unknown>).message === "string"
  ) {
    return (record.error as { message: string }).message;
  }

  return null;
};
