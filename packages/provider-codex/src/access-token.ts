import { CodexOAuthSessionTerminatedError, refreshCodexAccessToken } from './auth/oauth.ts';
import { findCodexAccountIndex, readCodexUpstreamState, replaceCodexAccount, type CodexAccessTokenEntry, type CodexAccountCredential } from './state.ts';
import { getProviderRepo, isAbortError, UpstreamGoneError, type Fetcher } from '@floway-dev/provider';

export type { CodexAccessTokenEntry };

export type CodexCredentialGeneration = Pick<CodexAccountCredential, 'chatgptAccountId' | 'refresh_token' | 'state_updated_at'>;

interface AccessTokenPersistenceGeneration {
  readonly accountId: string;
  readonly refreshToken: string;
  readonly stateUpdatedAt?: string;
}

export class CodexCredentialRefreshTerminatedError extends CodexOAuthSessionTerminatedError {
  readonly generation!: CodexCredentialGeneration;

  constructor(error: CodexOAuthSessionTerminatedError, generation: CodexCredentialGeneration) {
    super({ code: error.code, message: error.upstreamMessage });
    this.name = 'CodexCredentialRefreshTerminatedError';
    Object.defineProperty(this, 'generation', { value: generation, enumerable: false });
    Object.defineProperty(this, 'cause', { value: error, enumerable: false });
  }
}

// Refresh window: a cached token within this much of expiry counts as
// already-expired so the next call mints a fresh one rather than racing the
// upstream clock. Matches the data-plane's pre-call freshness gate.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const isAccessTokenFresh = (entry: CodexAccessTokenEntry): boolean =>
  entry.expiresAt > Date.now() + REFRESH_SKEW_MS;

// The whole change is expressed against the state the repo hands us, so a
// write that loses its race is simply replayed against the winner's document
// and both changes survive. Storage failures propagate so the request path
// surfaces them rather than silently running on a stale cached token.
const persistAccessToken = async (
  upstreamId: string,
  accountId: string,
  entry: CodexAccessTokenEntry | null,
  where: string,
  expectedToken?: string,
  expectedGeneration?: AccessTokenPersistenceGeneration,
): Promise<'persisted' | 'gone' | 'account-missing' | 'generation-mismatch' | 'token-mismatch'> => {
  // The mutator is replayed on a lost race, so the diagnostic is recorded and
  // emitted once afterwards rather than logged from inside it.
  let accountMissing = false;
  let generationMismatch = false;
  let tokenMismatch = false;
  try {
    await getProviderRepo().upstreams.saveState(upstreamId, current => {
      const state = readCodexUpstreamState(current);
      const idx = findCodexAccountIndex(state, accountId);
      if (idx < 0) {
        accountMissing = true;
        return current;
      }
      accountMissing = false;
      const account = state.accounts[idx];
      if (expectedGeneration !== undefined && (
        account.chatgptAccountId !== expectedGeneration.accountId
        || account.refresh_token !== expectedGeneration.refreshToken
        || (expectedGeneration.stateUpdatedAt !== undefined && account.state_updated_at !== expectedGeneration.stateUpdatedAt)
      )) {
        generationMismatch = true;
        tokenMismatch = false;
        return current;
      }
      generationMismatch = false;
      // Invalidation belongs to the request that observed `expectedToken`.
      // A sibling refresh or operator re-import may already have installed a
      // newer token; that generation must survive the late 401.
      if (entry === null && state.accounts[idx].accessToken?.token !== expectedToken) {
        tokenMismatch = true;
        return current;
      }
      tokenMismatch = false;
      return replaceCodexAccount(state, idx, account => ({ ...account, accessToken: entry }));
    }, { kind: 'codex' });
  } catch (err) {
    // A minted access token is bookkeeping the next request re-derives, so an
    // operator deleting the upstream mid-request is not worth failing that
    // request over. Every other storage failure still propagates.
    if (!(err instanceof UpstreamGoneError)) throw err;
    console.warn(`${where}: Codex upstream ${upstreamId} disappeared mid-request`);
    return 'gone';
  }
  if (accountMissing) {
    console.warn(`${where}: Codex account ${accountId} not found in upstream ${upstreamId}`);
    return 'account-missing';
  }
  if (generationMismatch) return 'generation-mismatch';
  return tokenMismatch ? 'token-mismatch' : 'persisted';
};

export const invalidateCodexAccessToken = async (
  upstreamId: string,
  accountId: string,
  expectedToken: string,
): Promise<boolean> =>
  await persistAccessToken(upstreamId, accountId, null, 'invalidateCodexAccessToken', expectedToken) === 'persisted';

// Reads, mints, and persists. The mint callback is responsible for routing
// the rotated refresh_token through the upstream's persistence hook;
// `mintCodexAccessToken` below is the standard implementation.
//
// Refresh-race recovery: when the mint throws `invalid_grant`, it might mean
// either (a) the refresh_token is genuinely revoked, or (b) a sibling worker
// raced us, won the rotation, and our copy is now stale.
// `recoverFromRefreshRace` distinguishes by re-reading state for the same
// account slot and comparing the refresh token we used against what is now
// stored. If a sibling rotated, we return their freshly-minted access token
// — the caller treats it as a normal cache hit. If the stored value hasn't
// moved, we re-raise the original error so the data-plane / control-plane
// caller flips the row to `refresh_failed`. Mirrors sub2api
// `oauth_refresh_api.go:tryRecoverFromRefreshRace` (lines 173-193). All
// other terminal codes (`app_session_terminated`, `invalid_refresh_token`,
// `invalid_client`, `unauthorized_client`, `access_denied`) signal
// credential death under any race scenario and skip recovery.
// Process-local coalescing of concurrent ensure calls. On a cold start N
// requests on the same isolate would all see `accessToken === null` and
// each POST /oauth/token; the upstream rotates on every call so only one
// survives and the rest fall into `recoverFromRefreshRace`, burning N
// round-trips for one usable token. Coalescing here collapses the
// within-isolate herd to a single mint. Forced actions serialize behind any
// existing mint and then execute their own callback, preserving the proxy and
// transport the operator selected. Lazy callers may consume a successful
// shared mint, or a still-fresh persisted token while a forced refresh runs.
//
// Scope: per-isolate only. Cross-isolate siblings still race and are
// caught by `recoverFromRefreshRace` — same trade-off as claude-code.
export interface MintedCodexAccessToken {
  entry: CodexAccessTokenEntry;
  refreshToken: string;
}

export type CodexAccessTokenMintResult = CodexAccessTokenEntry | MintedCodexAccessToken;
export type CodexAccessTokenMint = (
  refreshToken: string,
  signal: AbortSignal,
) => Promise<CodexAccessTokenMintResult>;

interface CodexAccessTokenFlight {
  force: boolean;
  controller: AbortController;
  promise: Promise<CodexAccessTokenEntry>;
  waiters: number;
  settled: boolean;
}

const inFlightEnsures = new Map<string, CodexAccessTokenFlight>();

const awaitCodexAccessTokenFlight = async (
  flight: CodexAccessTokenFlight,
  signal: AbortSignal | undefined,
): Promise<CodexAccessTokenEntry> => {
  flight.waiters += 1;
  try {
    if (signal?.aborted) throw signal.reason;
    if (signal === undefined) return await flight.promise;
    return await new Promise<CodexAccessTokenEntry>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      void flight.promise.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  } finally {
    flight.waiters -= 1;
    if (!flight.settled && flight.waiters === 0) {
      flight.controller.abort(signal?.reason ?? new DOMException('Codex token refresh has no waiters', 'AbortError'));
    }
  }
};

export const ensureCodexAccessToken = async (
  upstreamId: string,
  accountId: string,
  mint: CodexAccessTokenMint,
  // When true, skip the "cached access_token is still fresh" fast-path and
  // always mint a fresh one. Dashboard's Refresh button sets this so the
  // operator sees the row's tokens actually rotate; the data plane leaves
  // it false so a live request served from cache stays cheap.
  force = false,
  signal?: AbortSignal,
): Promise<CodexAccessTokenEntry> => {
  if (signal?.aborted) throw signal.reason;
  const key = JSON.stringify([upstreamId, accountId]);
  const existing = inFlightEnsures.get(key);
  if (existing?.settled || existing?.controller.signal.aborted) {
    if (inFlightEnsures.get(key) === existing) inFlightEnsures.delete(key);
    return await ensureCodexAccessToken(upstreamId, accountId, mint, force, signal);
  }
  if (existing) {
    if (!force && existing.force) {
      const cached = await freshCodexAccessToken(upstreamId, accountId);
      if (signal?.aborted) throw signal.reason;
      if (cached !== null) return cached;
    }
    try {
      const entry = await awaitCodexAccessTokenFlight(existing, signal);
      if (!force) return entry;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof CodexOAuthSessionTerminatedError || isAbortError(error)) throw error;
      // A proxy or storage failure belongs to the caller whose callback drove
      // that flight. Once it settles, this caller retries through its own path.
    }
    if (inFlightEnsures.get(key) === existing) inFlightEnsures.delete(key);
    return await ensureCodexAccessToken(upstreamId, accountId, mint, force, signal);
  }
  const controller = new AbortController();
  const promise = ensureCodexAccessTokenInner(upstreamId, accountId, mint, true, force, controller.signal);
  const flight: CodexAccessTokenFlight = { force, controller, promise, waiters: 0, settled: false };
  inFlightEnsures.set(key, flight);
  void promise.finally(() => {
    flight.settled = true;
    if (inFlightEnsures.get(key) === flight) inFlightEnsures.delete(key);
  }).catch(() => {});
  return await awaitCodexAccessTokenFlight(flight, signal);
};

export const recoverCodexAccessTokenAfter401 = async (
  upstreamId: string,
  accountId: string,
  rejectedAccessToken: string,
  mint: CodexAccessTokenMint,
  signal?: AbortSignal,
): Promise<CodexAccessTokenEntry> => {
  await invalidateCodexAccessToken(upstreamId, accountId, rejectedAccessToken);
  // Conditional invalidation either cleared the rejected token or discovered a
  // newer sibling token. A normal ensure mints only in the former case.
  return await ensureCodexAccessToken(upstreamId, accountId, mint, false, signal);
};

const ensureCodexAccessTokenInner = async (
  upstreamId: string,
  accountId: string,
  mint: CodexAccessTokenMint,
  recoveryAllowed: boolean,
  force: boolean,
  signal: AbortSignal,
  generationRetryAllowed = true,
): Promise<CodexAccessTokenEntry> => {
  if (signal.aborted) throw signal.reason;
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (signal.aborted) throw signal.reason;
  if (!fresh) throw new Error(`Codex upstream ${upstreamId} not found`);
  const state = readCodexUpstreamState(fresh.state);
  const account = state.accounts.find(a => a.chatgptAccountId === accountId);
  if (!account) throw new Error(`Codex account ${accountId} not found in upstream ${upstreamId}`);
  if (account.state !== 'active') {
    throw new CodexOAuthSessionTerminatedError({
      code: account.state,
      message: account.state_message ?? `Codex account is ${account.state}`,
    });
  }
  if (account.accessToken && isAccessTokenFresh(account.accessToken) && !force) {
    return account.accessToken;
  }

  let mintResult: CodexAccessTokenMintResult;
  try {
    mintResult = await mint(account.refresh_token, signal);
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError && err.code === 'invalid_grant' && recoveryAllowed) {
      const recovered = await recoverFromRefreshRace(upstreamId, accountId, account.refresh_token, mint, signal);
      if (recovered) return recovered;
    }
    if (err instanceof CodexOAuthSessionTerminatedError) {
      throw new CodexCredentialRefreshTerminatedError(err, {
        chatgptAccountId: account.chatgptAccountId,
        refresh_token: account.refresh_token,
        state_updated_at: account.state_updated_at,
      });
    }
    throw err;
  }
  const minted = 'entry' in mintResult ? mintResult.entry : mintResult;
  const generation: AccessTokenPersistenceGeneration = {
    accountId: account.chatgptAccountId,
    refreshToken: 'entry' in mintResult ? mintResult.refreshToken : account.refresh_token,
    ...('entry' in mintResult ? {} : { stateUpdatedAt: account.state_updated_at }),
  };
  const persisted = await persistAccessToken(
    upstreamId,
    accountId,
    minted,
    'ensureCodexAccessToken',
    undefined,
    generation,
  );
  if (persisted === 'generation-mismatch' || persisted === 'account-missing') {
    if (!generationRetryAllowed) throw new Error(`Codex credential generation changed repeatedly for ${accountId}`);
    return await ensureCodexAccessTokenInner(upstreamId, accountId, mint, recoveryAllowed, force, signal, false);
  }
  return minted;
};

const freshCodexAccessToken = async (
  upstreamId: string,
  accountId: string,
): Promise<CodexAccessTokenEntry | null> => {
  const record = await getProviderRepo().upstreams.getById(upstreamId);
  if (record === null) return null;
  const account = readCodexUpstreamState(record.state).accounts.find(candidate => candidate.chatgptAccountId === accountId);
  return account?.state === 'active' && account.accessToken !== null && isAccessTokenFresh(account.accessToken)
    ? account.accessToken
    : null;
};

// `invalid_grant` ambiguity: dead refresh token, or a sibling worker raced
// us and we hold the rotated-out copy. Re-read state for the same
// `accountId` slot and compare. The "sibling rotated but no cached access
// token yet" subcase (e.g. a concurrent `invalidateCodexAccessToken`
// cleared it) re-enters the refresh flow once with the fresh RT in hand;
// the depth guard prevents runaway recursion if recovery itself observes a
// stale view. Returns `null` when the original error should be re-raised as
// a real session termination.
const recoverFromRefreshRace = async (
  upstreamId: string,
  accountId: string,
  usedRefreshToken: string,
  mint: CodexAccessTokenMint,
  signal: AbortSignal,
): Promise<CodexAccessTokenEntry | null> => {
  const reread = await getProviderRepo().upstreams.getById(upstreamId);
  if (signal.aborted) throw signal.reason;
  if (!reread) return null;
  const rereadState = readCodexUpstreamState(reread.state);
  const rereadAccount = rereadState.accounts.find(a => a.chatgptAccountId === accountId);
  if (!rereadAccount) return null;
  if (rereadAccount.state !== 'active') return null;
  if (rereadAccount.refresh_token === usedRefreshToken) return null;
  console.info(
    `Codex refresh-race recovered for upstream ${upstreamId} account ${accountId}: sibling rotated, using their access token`,
  );
  if (rereadAccount.accessToken && isAccessTokenFresh(rereadAccount.accessToken)) {
    return rereadAccount.accessToken;
  }
  // Sibling rotated the refresh token but no usable access token sits in
  // state — most likely an `invalidateCodexAccessToken` ran between the
  // sibling's rotation and our re-read. Re-enter the refresh flow once with
  // the live RT; the re-entrant call sees the rotated row and goes straight
  // through the standard mint path. The depth guard suppresses a second
  // recovery attempt — if `invalid_grant` strikes again the refresh token
  // really is dead and we want the terminal flip.
  return await ensureCodexAccessTokenInner(upstreamId, accountId, mint, false, false, signal);
};

// Mints a fresh access token via /oauth/token and routes the rotated
// refresh_token through the caller's persistence hook. Awaiting the rotation
// persistence (rather than fire-and-forget) is deliberate: under concurrent
// rotations each call's new refresh_token must reach the hook before the
// next attempt reads state, otherwise an unhandled rejection can swallow the
// rotated token and the upstream eventually returns app_session_terminated.
export const mintCodexAccessToken = async (
  refreshToken: string,
  fetcher: Fetcher,
  persistRefreshTokenRotation: (newRefreshToken: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<MintedCodexAccessToken> => {
  const tokens = await refreshCodexAccessToken(refreshToken, fetcher, signal);
  await persistRefreshTokenRotation(tokens.refresh_token);
  return {
    refreshToken: tokens.refresh_token,
    entry: {
      token: tokens.access_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      refreshedAt: new Date().toISOString(),
    },
  };
};
