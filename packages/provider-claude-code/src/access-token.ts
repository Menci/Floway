import {
  ClaudeCodeOAuthSessionTerminatedError,
  refreshClaudeCodeAccessToken,
} from './auth/oauth.ts';
import { logInfo, logWarn } from './log.ts';
import {
  readClaudeCodeUpstreamState,
  replaceSoleAccount,
  type ClaudeCodeAccessTokenEntry,
  type ClaudeCodeAccountCredential,
} from './state.ts';
import type { Fetcher, UpstreamsRepoSlim } from '@floway-dev/provider';

export type { ClaudeCodeAccessTokenEntry };

export interface ClaudeCodeCredentialGeneration {
  readonly accountUuid: string;
  readonly tokenKind: ClaudeCodeAccountCredential['tokenKind'];
  readonly refreshToken: string | null;
  readonly stateUpdatedAt: string;
  readonly accessToken: string;
}

export const claudeCodeCredentialGeneration = (
  account: ClaudeCodeAccountCredential,
  accessToken: ClaudeCodeAccessTokenEntry,
): ClaudeCodeCredentialGeneration => ({
  accountUuid: account.accountUuid,
  tokenKind: account.tokenKind,
  refreshToken: account.refreshToken,
  stateUpdatedAt: account.stateUpdatedAt,
  accessToken: accessToken.token,
});

export const isClaudeCodeCredentialGeneration = (
  account: ClaudeCodeAccountCredential,
  generation: ClaudeCodeCredentialGeneration,
): boolean => account.state === 'active'
  && account.accountUuid === generation.accountUuid
  && account.tokenKind === generation.tokenKind
  && account.refreshToken === generation.refreshToken
  && account.stateUpdatedAt === generation.stateUpdatedAt
  && account.accessToken?.token === generation.accessToken;

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
  generation: ClaudeCodeCredentialGeneration;
}

// Refresh window: a cached token within this much of expiry counts as
// already-expired so the next call mints a fresh one rather than racing the
// upstream clock. Matches codex's pre-call freshness gate.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const isAccessTokenFresh = (entry: ClaudeCodeAccessTokenEntry): boolean =>
  entry.expiresAt > Date.now() + REFRESH_SKEW_MS;

const sameCredentialGeneration = (
  current: ClaudeCodeAccountCredential,
  expected: ClaudeCodeAccountCredential,
): boolean => current.accountUuid === expected.accountUuid
  && current.tokenKind === expected.tokenKind
  && current.refreshToken === expected.refreshToken
  && current.stateUpdatedAt === expected.stateUpdatedAt;

export interface EnsureClaudeCodeAccessTokenArgs {
  upstreamId: string;
  repo: UpstreamsRepoSlim;
  fetcher: Fetcher;
  // When true, skip the "cached access_token is still fresh" fast-path and
  // always call the OAuth refresh endpoint. The dashboard's Refresh button
  // sets this so the operator sees the row's tokens actually rotate; the
  // data plane leaves it false so a live request served from cache stays
  // cheap. Forced actions serialize behind earlier work and then run through
  // their own fetcher; lazy callers can share a successful mint.
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
interface ClaudeCodeAccessTokenFlight {
  force: boolean;
  promise: Promise<EnsuredAccessToken>;
}

const inFlightEnsures = new Map<string, ClaudeCodeAccessTokenFlight>();

export const ensureClaudeCodeAccessToken = async (
  args: EnsureClaudeCodeAccessTokenArgs,
): Promise<EnsuredAccessToken> => {
  const key = args.upstreamId;
  const existing = inFlightEnsures.get(key);
  if (existing) {
    if (!args.force && existing.force) {
      const cached = await freshClaudeCodeAccessToken(args);
      if (cached !== null) return cached;
    }
    try {
      const ensured = await existing.promise;
      if (!args.force) return ensured;
    } catch (error) {
      if (error instanceof ClaudeCodeOAuthSessionTerminatedError) throw error;
      // The failed flight used another caller's fetcher. Retry this caller once
      // the shared rotation slot is free.
    }
    if (inFlightEnsures.get(key) === existing) inFlightEnsures.delete(key);
    return await ensureClaudeCodeAccessToken(args);
  }
  const promise = ensureClaudeCodeAccessTokenInner(args, true);
  const flight: ClaudeCodeAccessTokenFlight = { force: args.force === true, promise };
  inFlightEnsures.set(key, flight);
  try {
    return await promise;
  } finally {
    if (inFlightEnsures.get(key) === flight) inFlightEnsures.delete(key);
  }
};

// Reads, refreshes, and persists. The rotated refresh token and the new
// cached access token are committed together in a single state write; the
// repo applies our change to whatever state it finds, so a quota write or a
// sibling rotation landing in between costs us nothing.
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
      return {
        entry: account.accessToken,
        freshlyMinted: false,
        generation: claudeCodeCredentialGeneration(account, account.accessToken),
      };
    }
    const message = 'Setup token expired or absent; re-import to recover';
    await persistTerminalState(args.repo, args.upstreamId, account, {
      reason: 'setup_token_expired',
      message,
      oauthCode: null,
    });
    throw new ClaudeCodeOAuthSessionTerminatedError({ code: 'setup_token_expired', message });
  }

  if (account.accessToken && isAccessTokenFresh(account.accessToken) && !args.force) {
    return {
      entry: account.accessToken,
      freshlyMinted: false,
      generation: claudeCodeCredentialGeneration(account, account.accessToken),
    };
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
      await persistTerminalState(args.repo, args.upstreamId, account, {
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

  // Refresh-token rotation: the new refresh token and the fresh access-token
  // entry land in one state transition. `state` / `stateUpdatedAt` stay
  // untouched on a successful refresh — 'active' is already what we want, and
  // bumping the timestamp on every refresh would muddy the dashboard's
  // "credential health changed" signal.
  //
  // The two fields are set on whatever account the repo hands us rather than
  // on the account we read before the round-trip: the upstream has already
  // invalidated the token we rotated out, so this write must survive a
  // concurrent quota write. A re-import that changed the credential class or
  // refresh-token generation in the meantime leaves the new account untouched;
  // this call then re-enters against the current generation.
  const rotatedRefreshToken = refreshed.refresh_token;
  if (typeof rotatedRefreshToken !== 'string' || rotatedRefreshToken === '') {
    throw new Error('Claude Code refresh response missing refresh_token');
  }
  let rotationApplied = false;
  await args.repo.saveState(args.upstreamId, current => {
    rotationApplied = false;
    const storedState = readClaudeCodeUpstreamState(current);
    const stored = storedState.accounts[0];
    if (stored.state !== 'active' || stored.tokenKind !== 'oauth' || !sameCredentialGeneration(stored, account)) return storedState;
    rotationApplied = true;
    return replaceSoleAccount(storedState, () => ({
      ...stored,
      refreshToken: rotatedRefreshToken,
      accessToken: newAccessTokenEntry,
    }));
  }, { kind: 'claude-code' });
  if (!rotationApplied) return await ensureClaudeCodeAccessTokenInner(args, false);
  logInfo('claude_code_refresh_token_rotated', {
    upstream_id: args.upstreamId,
    account_uuid: account.accountUuid,
    expires_in_seconds: refreshed.expires_in,
    refreshed_at: now,
  });
  return {
    entry: newAccessTokenEntry,
    freshlyMinted: true,
    generation: claudeCodeCredentialGeneration({
      ...account,
      refreshToken: rotatedRefreshToken,
      accessToken: newAccessTokenEntry,
    }, newAccessTokenEntry),
  };
};

const freshClaudeCodeAccessToken = async (
  args: EnsureClaudeCodeAccessTokenArgs,
): Promise<EnsuredAccessToken | null> => {
  const record = await args.repo.getById(args.upstreamId);
  if (record === null) return null;
  const account = readClaudeCodeUpstreamState(record.state).accounts[0];
  if (account.state !== 'active' || account.accessToken === null || !isAccessTokenFresh(account.accessToken)) return null;
  return {
    entry: account.accessToken,
    freshlyMinted: false,
    generation: claudeCodeCredentialGeneration(account, account.accessToken),
  };
};

// Terminal flip from the oauth-error path. Distinct from fetch.ts's
// `persistTerminalAccountState`: the caller has already read the account and
// established that it is active, so the log's identity and `from_state` come
// from that read instead of a second one, and the trigger is an oauth-protocol
// code (logged as `oauth_code`, possibly null for code-internal flips).
const persistTerminalState = async (
  repo: UpstreamsRepoSlim,
  upstreamId: string,
  previousAccount: ClaudeCodeAccountCredential,
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
  // Stamped before the write: the mutator is replayed on a lost race and must
  // return the same document each time. The write applies only to the
  // credential generation that produced the failure, so a late response cannot
  // invalidate an operator's concurrent re-import.
  const flippedAt = new Date().toISOString();
  let stateFlipped = false;
  await repo.saveState(upstreamId, current => {
    stateFlipped = false;
    const state = readClaudeCodeUpstreamState(current);
    const account = state.accounts[0];
    const generationMatches = previousAccount.tokenKind === 'oauth'
      ? sameCredentialGeneration(account, previousAccount)
      : account.tokenKind === 'setup-token'
        && account.accountUuid === previousAccount.accountUuid
        && account.accessToken?.token === previousAccount.accessToken?.token
        && account.stateUpdatedAt === previousAccount.stateUpdatedAt;
    if (account.state !== 'active' || account.accountUuid !== previousAccount.accountUuid || !generationMatches) return state;
    stateFlipped = true;
    return replaceSoleAccount(state, currentAccount => ({
      ...currentAccount,
      state: 'refresh_failed',
      stateMessage: fields.message,
      stateUpdatedAt: flippedAt,
      accessToken: null,
    }));
  }, { kind: 'claude-code' });
  if (!stateFlipped) return;
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
    return {
      entry: rereadAccount.accessToken,
      freshlyMinted: false,
      generation: claudeCodeCredentialGeneration(rereadAccount, rereadAccount.accessToken),
    };
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
// refresh token, so the next call mints a fresh one. An account whose slot is
// already empty is returned untouched, which the repo reads as "nothing to do".
export const invalidateClaudeCodeAccessToken = async (args: {
  upstreamId: string;
  repo: UpstreamsRepoSlim;
  expectedToken: string;
}): Promise<void> => {
  await args.repo.saveState(args.upstreamId, current => {
    const state = readClaudeCodeUpstreamState(current);
    if (state.accounts[0].accessToken?.token !== args.expectedToken) return state;
    return replaceSoleAccount(state, account => ({ ...account, accessToken: null }));
  }, { kind: 'claude-code' });
};
