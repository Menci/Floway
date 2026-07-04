/**
 * Cursor OAuth token refresh.
 *
 * Cursor's refresh endpoint is `POST /auth/exchange_user_api_key` with the
 * refresh token as a Bearer token and an empty JSON body — distinct from the
 * standard OAuth2 /token grant_type=refresh_token flow used by Codex/Claude.
 * Returns { accessToken, refreshToken }.
 */

import type { Fetcher } from '@floway-dev/provider';

const CURSOR_REFRESH_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key';

export interface CursorOAuthTokens {
  access_token: string;
  refresh_token: string;
  /** Absolute expiry in ms epoch (exp - 5min safety margin). */
  expires_at: number;
}

/**
 * Terminal error: the refresh token is dead and the operator must re-import.
 * Cursor's refresh endpoint doesn't return a structured OAuth error code, so
 * we classify by HTTP status — 401/403 unambiguously mean the session is gone.
 */
export class CursorSessionTerminatedError extends Error {
  readonly status: number;
  readonly upstreamMessage: string;
  constructor(args: { status: number; message: string }) {
    super(`Cursor OAuth session terminated: ${args.message}`);
    this.name = 'CursorSessionTerminatedError';
    this.status = args.status;
    this.upstreamMessage = args.message;
  }
}

const isTerminalStatus = (status: number): boolean => status === 401 || status === 403;

export const refreshCursorAccessToken = async (refreshToken: string, fetcher: Fetcher): Promise<CursorOAuthTokens> => {
  const response = await fetcher(CURSOR_REFRESH_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${refreshToken}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = rawText.length > 0 ? JSON.parse(rawText) : {};
  } catch {
    parsed = { _nonJsonBody: rawText };
  }

  const root = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;

  if (!response.ok) {
    const message = typeof root?.['message'] === 'string' ? (root['message'] as string) : rawText.slice(0, 256);
    if (isTerminalStatus(response.status)) {
      throw new CursorSessionTerminatedError({ status: response.status, message });
    }
    throw new Error(`Cursor token refresh failed: ${response.status} - ${message}`);
  }

  if (root === null) throw new Error('Cursor token refresh response is not an object');
  if (typeof root['accessToken'] !== 'string' || root['accessToken'] === '') {
    throw new Error('Cursor token refresh response missing accessToken');
  }

  const accessToken = root['accessToken'] as string;
  const refreshTokenNew = typeof root['refreshToken'] === 'string' && root['refreshToken'] !== '' ? (root['refreshToken'] as string) : refreshToken;

  return {
    access_token: accessToken,
    refresh_token: refreshTokenNew,
    expires_at: getTokenExpiry(accessToken),
  };
};

/**
 * Extract JWT expiry with a 5-minute safety margin. Falls back to 1 hour from
 * now if the token can't be parsed as a JWT.
 */
export function getTokenExpiry(token: string): number {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return Date.now() + 3600 * 1000;
    const decoded = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    if (decoded && typeof decoded === 'object' && typeof (decoded as { exp?: unknown }).exp === 'number') {
      return ((decoded as { exp: number }).exp * 1000) - 5 * 60 * 1000;
    }
  } catch {
    // not a JWT
  }
  return Date.now() + 3600 * 1000;
}
