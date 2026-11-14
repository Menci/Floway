import { parseChatGPTIdTokenPlanType } from './auth/jwt.ts';
import { ChatGPTOAuthSessionTerminatedError, chatgptTokenExpiresAt, refreshChatGPTAccessToken } from './auth/oauth.ts';
import { findChatGPTAccountIndex, readChatGPTUpstreamState, replaceChatGPTAccount, type ChatGPTAccessTokenEntry } from './state.ts';
import { getProviderRepo, UpstreamGoneError, type Fetcher } from '@floway-dev/provider';

export type { ChatGPTAccessTokenEntry };

// An access-only credential has no refresh token, so there is nothing to
// re-mint from. Distinct from a session termination: the credential was never
// renewable, and the only recovery is a re-import.
export class ChatGPTAccessOnlyCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatGPTAccessOnlyCredentialError';
  }
}

// Refresh window: a renewable credential's cached token within this much of
// expiry counts as already-expired so the next call mints a fresh one rather
// than racing the upstream clock. Matches the data-plane's pre-call freshness
// gate.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

// An access-only credential gets no skew — spending the last five minutes of
// a bearer it cannot replace is strictly better than discarding it — and an
// unknown expiry reads as usable, because the upstream's rejection is the only
// expiry signal such a credential has. For a renewable credential the same
// unknown expiry reads as unusable instead: it can just mint a new one, and a
// token of unknown remaining life is not worth a request.
const isAccessTokenUsable = (entry: ChatGPTAccessTokenEntry, renewable: boolean): boolean => {
  if (entry.expiresAt === null) return !renewable;
  return entry.expiresAt > Date.now() + (renewable ? REFRESH_SKEW_MS : 0);
};

export interface ChatGPTPlanObservation {
  planType: string;
  observedAt?: string;
}

export const chatgptPlanObservation = (entry: ChatGPTAccessTokenEntry | null | undefined): ChatGPTPlanObservation | null =>
  entry?.planType === undefined
    ? null
    : { planType: entry.planType, observedAt: entry.planObservedAt ?? entry.refreshedAt };

const observationTime = (observation: ChatGPTPlanObservation): number => {
  const parsed = observation.observedAt === undefined ? Number.NaN : Date.parse(observation.observedAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

const latestPlanObservation = (
  first: ChatGPTPlanObservation | null,
  second: ChatGPTPlanObservation | null,
  fallback: ChatGPTPlanObservation | undefined,
): ChatGPTPlanObservation | null => {
  const observations = [first, second, fallback ?? null]
    .filter((value): value is ChatGPTPlanObservation => value !== null);
  if (observations.length === 0) return null;
  return observations.reduce((latest, candidate) =>
    observationTime(candidate) > observationTime(latest) ? candidate : latest);
};

const mergeChatGPTAccessTokenEntry = (
  incoming: ChatGPTAccessTokenEntry,
  current: ChatGPTAccessTokenEntry | null | undefined,
  fallbackPlan: ChatGPTPlanObservation | undefined,
): ChatGPTAccessTokenEntry => {
  const incomingTime = Date.parse(incoming.refreshedAt);
  const currentTime = current === null || current === undefined ? Number.NEGATIVE_INFINITY : Date.parse(current.refreshedAt);
  const token = Number.isFinite(currentTime) && (!Number.isFinite(incomingTime) || currentTime >= incomingTime)
    ? current!
    : incoming;
  const plan = latestPlanObservation(chatgptPlanObservation(incoming), chatgptPlanObservation(current), fallbackPlan);
  const { planType: _planType, planObservedAt: _planObservedAt, ...tokenFields } = token;
  return plan === null
    ? tokenFields
    : {
        ...tokenFields,
        planType: plan.planType,
        ...(plan.observedAt === undefined ? {} : { planObservedAt: plan.observedAt }),
      };
};

interface PersistChatGPTAccessTokenOptions {
  upstreamId: string;
  accountId: string | null;
  entry: ChatGPTAccessTokenEntry | null;
  where: string;
  fallbackPlan?: ChatGPTPlanObservation;
}

// The whole change is expressed against the state the repo hands us, so a
// write that loses its race is simply replayed against the winner's document
// and both changes survive. Storage failures propagate so the request path
// surfaces them rather than silently running on a stale cached token.
const persistAccessToken = async (opts: PersistChatGPTAccessTokenOptions): Promise<ChatGPTAccessTokenEntry | null> => {
  // The mutator is replayed on a lost race, so the diagnostic is recorded and
  // emitted once afterwards rather than logged from inside it.
  let accountMissing = false;
  let effectiveEntry = opts.entry;
  try {
    await getProviderRepo().upstreams.saveState(opts.upstreamId, current => {
      const state = readChatGPTUpstreamState(current);
      const idx = findChatGPTAccountIndex(state, opts.accountId);
      if (idx < 0) {
        accountMissing = true;
        return current;
      }
      accountMissing = false;
      // Invalidating an already-null slot has nothing to write — the case where
      // a 401 retry races a concurrent refresh that already cleared the token.
      if (opts.entry === null && state.accounts[idx].accessToken === null) return current;
      effectiveEntry = opts.entry === null
        ? null
        : mergeChatGPTAccessTokenEntry(opts.entry, state.accounts[idx].accessToken, opts.fallbackPlan);
      if (JSON.stringify(effectiveEntry) === JSON.stringify(state.accounts[idx].accessToken)) return current;
      return replaceChatGPTAccount(state, idx, account => ({ ...account, accessToken: effectiveEntry }));
    });
  } catch (err) {
    // A minted access token is bookkeeping the next request re-derives, so an
    // operator deleting the upstream mid-request is not worth failing that
    // request over. Every other storage failure still propagates.
    if (!(err instanceof UpstreamGoneError)) throw err;
    console.warn(`${opts.where}: ChatGPT upstream ${opts.upstreamId} disappeared mid-request`);
    return effectiveEntry;
  }
  if (accountMissing) {
    console.warn(`${opts.where}: ChatGPT account ${opts.accountId} not found in upstream ${opts.upstreamId}`);
  }
  return effectiveEntry;
};

export const putChatGPTAccessToken = async (
  upstreamId: string,
  accountId: string | null,
  entry: ChatGPTAccessTokenEntry,
  fallbackPlan?: ChatGPTPlanObservation,
): Promise<ChatGPTAccessTokenEntry> =>
  (await persistAccessToken({ upstreamId, accountId, entry, where: 'putChatGPTAccessToken', fallbackPlan })) ?? entry;

export const invalidateChatGPTAccessToken = async (
  upstreamId: string,
  accountId: string | null,
  expectedToken?: string,
): Promise<ChatGPTAccessTokenEntry | null> => {
  if (expectedToken === undefined) {
    return await persistAccessToken({ upstreamId, accountId, entry: null, where: 'invalidateChatGPTAccessToken' });
  }
  let retained: ChatGPTAccessTokenEntry | null = null;
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readChatGPTUpstreamState(current);
    const idx = findChatGPTAccountIndex(state, accountId);
    if (idx < 0) throw new Error(`invalidateChatGPTAccessToken: ChatGPT account ${accountId} not found in upstream ${upstreamId}`);
    const entry = state.accounts[idx].accessToken;
    if (entry !== null && entry.token !== expectedToken) {
      retained = entry;
      return current;
    }
    if (entry === null) return current;
    return replaceChatGPTAccount(state, idx, account => ({ ...account, accessToken: null }));
  });
  return retained;
};

// Reads, mints, and persists. The mint callback is responsible for routing
// the rotated refresh_token through the upstream's persistence hook;
// `mintChatGPTAccessToken` below is the standard implementation.
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
// within-isolate herd to a single mint. Key includes `force` so a
// dashboard `force: true` click never rides on a concurrent lazy call's
// cache-hit result (and vice versa); concurrent forces still collapse.
//
// Scope: per-isolate only. Cross-isolate siblings still race and are
// caught by `recoverFromRefreshRace` — same trade-off as claude-code.
const inFlightEnsures = new Map<string, Promise<ChatGPTAccessTokenEntry>>();

export const ensureChatGPTAccessToken = async (
  upstreamId: string,
  accountId: string | null,
  mint: (refreshToken: string) => Promise<ChatGPTAccessTokenEntry>,
  // When true, skip the "cached access_token is still fresh" fast-path and
  // always mint a fresh one. Dashboard's Refresh button sets this so the
  // operator sees the row's tokens actually rotate; the data plane leaves
  // it false so a live request served from cache stays cheap.
  force = false,
): Promise<ChatGPTAccessTokenEntry> => {
  // `null` is a legitimate account id, so the key has to keep it distinct from
  // the string "null" a template would produce.
  const key = JSON.stringify([upstreamId, accountId, force]);
  const existing = inFlightEnsures.get(key);
  if (existing) return await existing;
  const promise = ensureChatGPTAccessTokenInner(upstreamId, accountId, mint, true, force);
  inFlightEnsures.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightEnsures.delete(key);
  }
};

const ensureChatGPTAccessTokenInner = async (
  upstreamId: string,
  accountId: string | null,
  mint: (refreshToken: string) => Promise<ChatGPTAccessTokenEntry>,
  recoveryAllowed: boolean,
  force: boolean,
): Promise<ChatGPTAccessTokenEntry> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) throw new Error(`ChatGPT upstream ${upstreamId} not found`);
  const state = readChatGPTUpstreamState(fresh.state);
  const account = state.accounts.find(a => a.chatgptAccountId === accountId);
  if (!account) throw new Error(`ChatGPT account ${accountId} not found in upstream ${upstreamId}`);
  const renewable = account.refresh_token !== null;
  if (account.accessToken && isAccessTokenUsable(account.accessToken, renewable) && !force) {
    return account.accessToken;
  }
  // Nothing left to try for an access-only credential: the bearer in hand is
  // all there is, and it is either expired or absent. Say which, because the
  // operator's fix is the same but the reason changes what they check.
  if (account.refresh_token === null) {
    if (force) {
      throw new ChatGPTAccessOnlyCredentialError('ChatGPT access-only credentials cannot be refreshed; re-import the credential');
    }
    if (account.accessToken !== null && account.accessToken.expiresAt !== null && account.accessToken.expiresAt <= Date.now()) {
      throw new ChatGPTAccessOnlyCredentialError('ChatGPT access token has expired and cannot be refreshed; re-import the credential');
    }
    throw new ChatGPTAccessOnlyCredentialError('ChatGPT access-only credential has no usable access token; re-import the credential');
  }

  const refreshToken = account.refresh_token;
  let minted;
  try {
    minted = await mint(refreshToken);
  } catch (err) {
    if (err instanceof ChatGPTOAuthSessionTerminatedError && err.code === 'invalid_grant' && recoveryAllowed) {
      const recovered = await recoverFromRefreshRace(upstreamId, accountId, refreshToken, mint);
      if (recovered) return recovered;
    }
    throw err;
  }
  return (await persistAccessToken({
    upstreamId,
    accountId,
    entry: minted,
    where: 'ensureChatGPTAccessToken',
    fallbackPlan: chatgptPlanObservation(account.accessToken) ?? undefined,
  })) ?? minted;
};

// `invalid_grant` ambiguity: dead refresh token, or a sibling worker raced
// us and we hold the rotated-out copy. Re-read state for the same
// `accountId` slot and compare. The "sibling rotated but no cached access
// token yet" subcase (e.g. a concurrent `invalidateChatGPTAccessToken`
// cleared it) re-enters the refresh flow once with the fresh RT in hand;
// the depth guard prevents runaway recursion if recovery itself observes a
// stale view. Returns `null` when the original error should be re-raised as
// a real session termination.
const recoverFromRefreshRace = async (
  upstreamId: string,
  accountId: string | null,
  usedRefreshToken: string,
  mint: (refreshToken: string) => Promise<ChatGPTAccessTokenEntry>,
): Promise<ChatGPTAccessTokenEntry | null> => {
  const reread = await getProviderRepo().upstreams.getById(upstreamId);
  if (!reread) return null;
  const rereadState = readChatGPTUpstreamState(reread.state);
  const rereadAccount = rereadState.accounts.find(a => a.chatgptAccountId === accountId);
  if (!rereadAccount) return null;
  if (rereadAccount.state !== 'active') return null;
  if (rereadAccount.refresh_token === usedRefreshToken) return null;
  console.info(
    `ChatGPT refresh-race recovered for upstream ${upstreamId} account ${accountId}: sibling rotated, using their access token`,
  );
  if (rereadAccount.accessToken && isAccessTokenUsable(rereadAccount.accessToken, rereadAccount.refresh_token !== null)) {
    return rereadAccount.accessToken;
  }
  // Sibling rotated the refresh token but no usable access token sits in
  // state — most likely an `invalidateChatGPTAccessToken` ran between the
  // sibling's rotation and our re-read. Re-enter the refresh flow once with
  // the live RT; the re-entrant call sees the rotated row and goes straight
  // through the standard mint path. The depth guard suppresses a second
  // recovery attempt — if `invalid_grant` strikes again the refresh token
  // really is dead and we want the terminal flip.
  return await ensureChatGPTAccessTokenInner(upstreamId, accountId, mint, false, false);
};

// Mints a fresh access token via /oauth/token and routes the rotated
// refresh_token through the caller's persistence hook. Awaiting the rotation
// persistence (rather than fire-and-forget) is deliberate: under concurrent
// rotations each call's new refresh_token must reach the hook before the
// next attempt reads state, otherwise an unhandled rejection can swallow the
// rotated token and the upstream eventually returns app_session_terminated.
export const mintChatGPTAccessToken = async (
  refreshToken: string,
  fetcher: Fetcher,
  persistRefreshTokenRotation: (newRefreshToken: string) => Promise<void>,
): Promise<ChatGPTAccessTokenEntry> => {
  const tokens = await refreshChatGPTAccessToken(refreshToken, fetcher);
  await persistRefreshTokenRotation(tokens.refresh_token);
  const planType = tokens.id_token === undefined ? undefined : parseChatGPTIdTokenPlanType(tokens.id_token);
  const refreshedAt = new Date().toISOString();
  return {
    token: tokens.access_token,
    expiresAt: chatgptTokenExpiresAt(tokens.expires_in),
    refreshedAt,
    ...(planType === undefined ? {} : { planType, planObservedAt: refreshedAt }),
  };
};
