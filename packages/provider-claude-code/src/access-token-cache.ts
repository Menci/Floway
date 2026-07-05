import {
  ClaudeCodeOAuthSessionTerminatedError,
  refreshClaudeCodeAccessToken,
} from './auth/oauth.ts';
import { logInfo, logWarn } from './log.ts';
import {
  readClaudeCodeUpstreamState,
  replaceSoleAccount,
  type ClaudeCodeAccessTokenEntry,
  type ClaudeCodeUpstreamState,
} from './state.ts';
import type { Fetcher, UpstreamsRepoSlim } from '@floway-dev/provider';

export type { ClaudeCodeAccessTokenEntry };

// Result of `ensureClaudeCodeAccessToken`. `freshlyMinted` is true when
// this call shared in a real /v1/oauth/token round-trip (either drove the
// mint itself, or coalesced onto an in-flight mint kicked off by a
// concurrent caller — see `inFlightEnsures` below) and false when a
// cached entry was returned. It means "this call site observed a fresh
// mint," not "minted recently": if a sibling request rotated the
// refresh-token between our repo read and the cache decision, the cache
// hit branch still reports false even though the cached token is genuinely
// fresh. The 401-retry path uses this to decide whether a 401 means the
// cached token is stale (invalidate + retry) or that the credential itself
// is dead (give up and surface the 401); the false-positive case (a sibling
// just minted) costs at most one harmless invalidate + re-mint.
export interface EnsuredAccessToken {
  entry: ClaudeCodeAccessTokenEntry;
  freshlyMinted: boolean;
}

// Refresh window: a cached token within this much of expiry counts as
// already-expired so the next call mints a fresh one rather than racing the
// upstream clock. Matches codex's pre-call freshness gate.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const isAccessTokenFresh = (entry: ClaudeCodeAccessTokenEntry): boolean =>
  entry.expiresAt > Date.now() + REFRESH_SKEW_MS;

export interface EnsureClaudeCodeAccessTokenArgs {
  upstreamId: string;
  repo: UpstreamsRepoSlim;
  fetcher: Fetcher;
  // When true, skip the "cached access_token is still fresh" fast-path and
  // always call the OAuth refresh endpoint. The dashboard's Refresh button
  // sets this so the operator sees the row's tokens actually rotate; the
  // data plane leaves it false so a live request served from cache stays
  // cheap. Coalescing keys on `(upstreamId, force)` so a force call never
  // returns a lazy call's cache-hit result and vice versa; concurrent
  // dashboard clicks still collapse to one refresh.
  force?: boolean;
}

// Process-local coalescing of concurrent ensure calls. On a cold start N
// requests on the same isolate would all see `accessToken === null` and
// each fire a `/v1/oauth/token` POST; the upstream rotates on every call so
// only one survives and the rest fall into `recoverFromRefreshRace`,
// burning N round-trips for one usable token. Coalescing here collapses
// the within-isolate herd to a single mint: later callers await the same
// promise and observe the first caller's result.
//
// Scope: per-isolate only. Cross-isolate dedup is impossible without a
// shared coordination store (Workers gives us none we have agreed to
// depend on), so siblings on other isolates still race; `recoverFromRefreshRace`
// catches the loser and serves the winner's freshly-rotated token. Sub2api
// gates the same path with a Redis SETNX lease (`oauth_refresh_api.go:91-105`)
// for true cluster-wide single-mint; we trade that for zero coordination
// state at the cost of cross-isolate-only round-trip duplication, which is
// the rare case.
const inFlightEnsures = new Map<string, Promise<EnsuredAccessToken>>();

export const ensureClaudeCodeAccessToken = async (
  args: EnsureClaudeCodeAccessTokenArgs,
): Promise<EnsuredAccessToken> => {
  const key = `${args.upstreamId}:${args.force ? 'force' : 'lazy'}`;
  const existing = inFlightEnsures.get(key);
  if (existing) return await existing;
  const promise = ensureClaudeCodeAccessTokenInner(args, true);
  inFlightEnsures.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightEnsures.delete(key);
  }
};

// Reads, refreshes, and persists. The rotated refresh token and the new
// cached access token are committed together in a single CAS write. CAS
// loss on that write is fatal: the upstream rotates on every refresh call,
// so a sibling rotation already burned the refresh token we hold, and
// reusing our response would be rejected as `invalid_grant`. We throw so
// the next request re-reads state and refreshes from the live tail of the
// rotation chain.
//
// Refresh-race recovery: when the upstream returns `invalid_grant`, it
// might mean either (a) the refresh token is genuinely revoked, or (b) a
// sibling worker raced us, won the rotation, and our copy is now stale.
// `recoverFromRefreshRace` distinguishes by re-reading state and comparing
// the refresh token we used against what is now stored. If a sibling
// rotated, we return their freshly-minted access token (`freshlyMinted:
// false` because this call site did not mint it). If the stored value
// hasn't moved, we treat it as a real death and flip to terminal. Mirrors
// sub2api `oauth_refresh_api.go:tryRecoverFromRefreshRace` (lines
// 173-193). All other terminal codes (`app_session_terminated`,
// `invalid_refresh_token`, `invalid_client`, `unauthorized_client`,
// `access_denied`) signal credential death under any race scenario and
// flip to terminal without a recovery attempt.
const ensureClaudeCodeAccessTokenInner = async (
  args: EnsureClaudeCodeAccessTokenArgs,
  recoveryAllowed: boolean,
): Promise<EnsuredAccessToken> => {
  const fresh = await args.repo.getById(args.upstreamId);
  if (!fresh) throw new Error(`Claude Code upstream ${args.upstreamId} not found`);
  const state = readClaudeCodeUpstreamState(fresh.state);

  const account = state.accounts[0];
  if (account.state !== 'active') {
    // Surface the stored health state as the `code` so a caller distinguishing
    // by code (e.g. metrics) reflects the persisted reason, not a synthetic
    // OAuth code. Never reaches the refresh-race recovery branch — that only
    // fires inside the catch around the live /v1/oauth/token call below.
    throw new ClaudeCodeOAuthSessionTerminatedError({ code: account.state, message: account.stateMessage });
  }

  // Setup-token: the cached access token IS the credential — there is no
  // refresh counterpart to rotate. When still fresh, return it. When inside
  // the refresh window, treat as a dead credential: flip to terminal and
  // surface a session-terminated error so the operator re-imports. The
  // 1-year validity makes the expiry path rare in practice.
  if (account.tokenKind === 'setup-token') {
    if (account.accessToken && isAccessTokenFresh(account.accessToken)) {
      return { entry: account.accessToken, freshlyMinted: false };
    }
    const message = 'Setup token expired or absent; re-import to recover';
    await persistTerminalState(args.repo, args.upstreamId, fresh.state, state, {
      reason: 'setup_token_expired',
      message,
      oauthCode: null,
    });
    throw new ClaudeCodeOAuthSessionTerminatedError({ code: 'setup_token_expired', message });
  }

  if (account.accessToken && isAccessTokenFresh(account.accessToken) && !args.force) {
    return { entry: account.accessToken, freshlyMinted: false };
  }

  let refreshed;
  try {
    refreshed = await refreshClaudeCodeAccessToken(account.refreshToken, args.fetcher);
  } catch (error) {
    if (error instanceof ClaudeCodeOAuthSessionTerminatedError) {
      if (error.code === 'invalid_grant' && recoveryAllowed) {
        const recovered = await recoverFromRefreshRace(args, account.refreshToken);
        if (recovered) return recovered;
      }
      await persistTerminalState(args.repo, args.upstreamId, fresh.state, state, {
        reason: 'oauth_refresh_failed',
        message: error.upstreamMessage,
        oauthCode: error.code,
      });
    }
    throw error;
  }

  const now = new Date().toISOString();
  const newAccessTokenEntry: ClaudeCodeAccessTokenEntry = {
    token: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    refreshedAt: now,
  };

  // Refresh-token rotation: CAS-write the new refresh token alongside the
  // fresh access-token cache in a single state transition. `state` /
  // `stateUpdatedAt` stay untouched on a successful refresh — 'active' is
  // already what we want, and bumping the timestamp on every refresh would
  // muddy the dashboard's "credential health changed" signal.
  const rotatedRefreshToken = refreshed.refresh_token;
  if (typeof rotatedRefreshToken !== 'string' || rotatedRefreshToken === '') {
    throw new Error('Claude Code refresh response missing refresh_token');
  }
  const rotated = replaceSoleAccount(state, () => ({
    ...account,
    refreshToken: rotatedRefreshToken,
    accessToken: newAccessTokenEntry,
  }));
  const result = await args.repo.saveState(args.upstreamId, rotated, { expectedState: fresh.state });
  if (!result.updated) {
    throw new Error(
      `Claude Code refresh-token rotation lost CAS for upstream ${args.upstreamId}; another rotation won`,
    );
  }
  logInfo('claude_code_refresh_token_rotated', {
    upstream_id: args.upstreamId,
    account_uuid: account.accountUuid,
    expires_in_seconds: refreshed.expires_in,
    refreshed_at: now,
  });
  return { entry: newAccessTokenEntry, freshlyMinted: true };
};

// Terminal flip from the oauth-error path. Distinct from fetch.ts's
// `persistTerminalAccountState`: caller already holds a fresh state read
// (so we take it as a param rather than re-reading), the trigger is an
// oauth-protocol code (logged as `oauth_code`, possibly null for
// code-internal flips), and the caller has already established the
// account is active.
const persistTerminalState = async (
  repo: UpstreamsRepoSlim,
  upstreamId: string,
  expectedState: unknown,
  current: ClaudeCodeUpstreamState,
  fields: {
    reason: string;
    message: string;
    // The raw OAuth `error` code (e.g. `invalid_grant`,
    // `app_session_terminated`) when the flip was triggered by an upstream
    // OAuth response; `null` for code-internal flips (e.g. setup-token
    // expiry) that have no upstream code to attribute.
    oauthCode: string | null;
  },
): Promise<void> => {
  const previousAccount = current.accounts[0];
  const flipped = replaceSoleAccount(current, account => ({
    ...account,
    state: 'refresh_failed',
    stateMessage: fields.message,
    stateUpdatedAt: new Date().toISOString(),
    accessToken: null,
  }));
  await repo.saveState(upstreamId, flipped, { expectedState });
  logWarn('claude_code_account_state_flip', {
    upstream_id: upstreamId,
    account_uuid: previousAccount.accountUuid,
    from_state: previousAccount.state,
    to_state: 'refresh_failed',
    reason: fields.reason,
    oauth_code: fields.oauthCode,
    message: fields.message,
  });
};

// `invalid_grant` ambiguity: dead refresh token, or a sibling worker raced
// us and we hold the rotated-out copy. Re-read state and compare. The
// "sibling rotated but no cached access token yet" subcase (e.g. a
// concurrent `invalidateClaudeCodeAccessToken` cleared it) re-enters the
// refresh flow once with the fresh RT in hand; the depth guard prevents
// runaway recursion if recovery itself observes a stale view. Returns
// `null` when the original error should be re-raised as a real session
// termination.
const recoverFromRefreshRace = async (
  args: EnsureClaudeCodeAccessTokenArgs,
  usedRefreshToken: string,
): Promise<EnsuredAccessToken | null> => {
  const reread = await args.repo.getById(args.upstreamId);
  if (!reread) return null;
  const rereadState = readClaudeCodeUpstreamState(reread.state);
  const rereadAccount = rereadState.accounts[0];
  if (rereadAccount.state !== 'active') return null;
  // Setup-token credentials don't reach this recovery path under normal
  // flow (they short-circuit in the main function); if a concurrent
  // re-import flipped the credential class between our refresh attempt
  // and the re-read, give up on recovery and let the original error
  // surface.
  if (rereadAccount.tokenKind === 'setup-token') return null;
  if (rereadAccount.refreshToken === usedRefreshToken) return null;
  logInfo('claude_code_refresh_race_recovered', {
    upstream_id: args.upstreamId,
    account_uuid: rereadAccount.accountUuid,
    rotated_refresh_token_prefix: rereadAccount.refreshToken.slice(0, 6),
  });
  if (rereadAccount.accessToken && isAccessTokenFresh(rereadAccount.accessToken)) {
    return { entry: rereadAccount.accessToken, freshlyMinted: false };
  }
  // Sibling rotated the refresh token but no usable access token sits in
  // state — most likely an `invalidateClaudeCodeAccessToken` ran between
  // the sibling's rotation and our re-read. Re-enter the refresh flow once
  // with the live RT; the re-entrant call sees the rotated row and goes
  // straight through the standard refresh path. The depth guard suppresses
  // a second recovery attempt — if `invalid_grant` strikes again the
  // refresh token really is dead and we want the terminal flip.
  return await ensureClaudeCodeAccessTokenInner(args, false);
};

// Used in 401-retry: clear the cached access token without touching the
// refresh token, so the next call mints a fresh one.
export const invalidateClaudeCodeAccessToken = async (args: {
  upstreamId: string;
  repo: UpstreamsRepoSlim;
}): Promise<void> => {
  const fresh = await args.repo.getById(args.upstreamId);
  if (!fresh) throw new Error(`Claude Code upstream ${args.upstreamId} disappeared mid-request`);
  const state = readClaudeCodeUpstreamState(fresh.state);
  const account = state.accounts[0];
  if (account.accessToken === null) return;
  const cleared = replaceSoleAccount(state, account => ({ ...account, accessToken: null }));
  await args.repo.saveState(args.upstreamId, cleared, { expectedState: fresh.state });
};
