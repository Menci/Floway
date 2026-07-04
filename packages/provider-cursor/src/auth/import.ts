// Cursor upstream import flow — poll-based login.
//
// Unlike Codex/Claude (callback paste), Cursor login is poll-based: the
// operator opens the authorize URL in a browser, and the gateway polls
// api2.cursor.sh/auth/poll until it returns tokens. This module owns the
// tokens → persisted config/state mapping; the authorize URL is generated
// by generateCursorAuthParams (poll.ts), and the control-plane routes wire
// pollCursorAuth in between.

import { getTokenExpiry } from './oauth.ts';
import type { CursorPollTokens } from './poll.ts';
import type { CursorAccountIdentity, CursorUpstreamConfig } from '../config.ts';
import type { CursorAccessTokenEntry, CursorUpstreamState } from '../state.ts';

export type { CursorPollTokens };

/**
 * Derive the account identity from the access token JWT. Cursor's JWT payload
 * fields are not fully documented; we read `sub` as the userId and `email` when
 * present, falling back to a stable placeholder so the (email, userId) identity
 * pair is always populated for the config tuple.
 */
export const deriveCursorIdentity = (accessToken: string): CursorAccountIdentity => {
  let userId = 'cursor-user';
  let email = 'cursor-user';
  try {
    const parts = accessToken.split('.');
    if (parts.length === 3 && parts[1]) {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
      if (typeof payload['sub'] === 'string' && payload['sub'] !== '') userId = payload['sub'];
      if (typeof payload['email'] === 'string' && payload['email'] !== '') email = payload['email'];
      else if (typeof payload['name'] === 'string' && payload['name'] !== '') email = payload['name'];
    }
  } catch {
    // not a JWT — keep placeholders
  }
  return { email, userId };
};

/** Build the persisted config (identity tuple) from a derived identity. */
export const buildCursorImportConfig = (identity: CursorAccountIdentity): CursorUpstreamConfig => ({
  accounts: [identity],
});

/**
 * Build the initial persisted state from poll tokens: an active credential
 * with the refresh token and a cached access token entry.
 */
export const buildCursorImportState = (tokens: CursorPollTokens): CursorUpstreamState => {
  const identity = deriveCursorIdentity(tokens.accessToken);
  const accessTokenEntry: CursorAccessTokenEntry = {
    token: tokens.accessToken,
    expiresAt: getTokenExpiry(tokens.accessToken),
    refreshedAt: new Date().toISOString(),
  };
  return {
    accounts: [
      {
        userId: identity.userId,
        refresh_token: tokens.refreshToken,
        state: 'active',
        state_updated_at: new Date().toISOString(),
        accessToken: accessTokenEntry,
      },
    ],
  };
};
