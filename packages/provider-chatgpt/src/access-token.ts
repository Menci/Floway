import { parseChatGPTIdTokenPlanType } from './auth/jwt.ts';
import { ChatGPTOAuthResponseError, ChatGPTOAuthSessionTerminatedError, chatgptTokenExpiresAt, refreshChatGPTAccessToken, refreshChatGPTAccessTokenResult, type ChatGPTOAuthFailure, type ChatGPTOAuthFetcher, type ChatGPTOAuthRefreshTokens } from './auth/oauth.ts';
import { findChatGPTAccountIndex, readChatGPTUpstreamState, replaceChatGPTAccount, type ChatGPTAccessTokenEntry, type ChatGPTAccountCredential } from './state.ts';
import type { Result } from '@floway-dev/pipeline';
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
  fallbackPlan?: ChatGPTPlanObservation | undefined;
  log?: ChatGPTTokenLog | undefined;
}

export interface ChatGPTTokenLog {
  readonly log: (event: string, fields: Record<string, unknown>) => unknown;
  readonly warn: (event: string, fields: Record<string, unknown>) => unknown;
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
  const { upstreams } = getProviderRepo();
  try {
    await upstreams.saveState(opts.upstreamId, current => {
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
    opts.log?.warn('chatgpt_access_token_upstream_removed', { upstream_id: opts.upstreamId, operation: opts.where });
    return effectiveEntry;
  }
  if (accountMissing) {
    opts.log?.warn('chatgpt_access_token_account_removed', { upstream_id: opts.upstreamId, account_id: opts.accountId, operation: opts.where });
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
): Promise<Result<ChatGPTAccessTokenEntry | null, Error>> => {
  if (expectedToken === undefined) {
    return { ok: true, value: await persistAccessToken({ upstreamId, accountId, entry: null, where: 'invalidateChatGPTAccessToken' }) };
  }
  const { upstreams } = getProviderRepo();
  let accountMissing = false;
  let retained: ChatGPTAccessTokenEntry | null = null;
  try {
    await upstreams.saveState(upstreamId, current => {
      const state = readChatGPTUpstreamState(current);
      const idx = findChatGPTAccountIndex(state, accountId);
      accountMissing = idx < 0;
      if (accountMissing) return current;
      const entry = state.accounts[idx].accessToken;
      if (entry !== null && entry.token !== expectedToken) {
        retained = entry;
        return current;
      }
      retained = null;
      if (entry === null) return current;
      return replaceChatGPTAccount(state, idx, account => ({ ...account, accessToken: null }));
    });
  } catch (error) {
    if (!(error instanceof UpstreamGoneError)) throw error;
    return { ok: false, error };
  }
  if (accountMissing) return { ok: false, error: new Error(`invalidateChatGPTAccessToken: ChatGPT account ${accountId} not found in upstream ${upstreamId}`) };
  return { ok: true, value: retained };
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
export type ChatGPTAccessTokenResult = Result<ChatGPTAccessTokenEntry, ChatGPTOAuthFailure | ChatGPTAccessOnlyCredentialError>;
export type ChatGPTAccessTokenMint = (refreshToken: string) => Promise<Result<ChatGPTAccessTokenEntry, ChatGPTOAuthFailure>>;

export const resolveChatGPTAccessToken = async (
  upstreamId: string,
  account: ChatGPTAccountCredential,
  mint: ChatGPTAccessTokenMint,
  force: boolean,
  log?: ChatGPTTokenLog,
): Promise<ChatGPTAccessTokenResult> => await ensureAccessToken(upstreamId, account, mint, true, force, log);

const ensureAccessToken = async (
  upstreamId: string,
  account: ChatGPTAccountCredential,
  mint: ChatGPTAccessTokenMint,
  recoveryAllowed: boolean,
  force: boolean,
  log: ChatGPTTokenLog | undefined,
): Promise<ChatGPTAccessTokenResult> => {
  const { chatgptAccountId: accountId } = account;
  const renewable = account.refresh_token !== null;
  if (account.accessToken && isAccessTokenUsable(account.accessToken, renewable) && !force) {
    return { ok: true, value: account.accessToken };
  }
  // Nothing left to try for an access-only credential: the bearer in hand is
  // all there is, and it is either expired or absent. Say which, because the
  // operator's fix is the same but the reason changes what they check.
  if (account.refresh_token === null) {
    if (force) {
      return { ok: false, error: new ChatGPTAccessOnlyCredentialError('ChatGPT access-only credentials cannot be refreshed; re-import the credential') };
    }
    if (account.accessToken !== null && account.accessToken.expiresAt !== null && account.accessToken.expiresAt <= Date.now()) {
      return { ok: false, error: new ChatGPTAccessOnlyCredentialError('ChatGPT access token has expired and cannot be refreshed; re-import the credential') };
    }
    return { ok: false, error: new ChatGPTAccessOnlyCredentialError('ChatGPT access-only credential has no usable access token; re-import the credential') };
  }

  const refreshToken = account.refresh_token;
  const minted = await mint(refreshToken);
  if (!minted.ok) {
    if (minted.error instanceof ChatGPTOAuthSessionTerminatedError && minted.error.code === 'invalid_grant' && recoveryAllowed) {
      const recovered = await recoverFromRefreshRace(upstreamId, accountId, refreshToken, mint, log);
      if (recovered) return recovered;
    }
    return minted;
  }
  const persisted = await persistAccessToken({
    upstreamId,
    accountId,
    entry: minted.value,
    where: 'ensureChatGPTAccessToken',
    fallbackPlan: chatgptPlanObservation(account.accessToken) ?? undefined,
    log,
  });
  return { ok: true, value: persisted ?? minted.value };
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
  mint: ChatGPTAccessTokenMint,
  log: ChatGPTTokenLog | undefined,
): Promise<ChatGPTAccessTokenResult | null> => {
  const reread = await getProviderRepo().upstreams.getById(upstreamId);
  if (!reread) return null;
  const rereadState = readChatGPTUpstreamState(reread.state);
  const rereadAccount = rereadState.accounts.find(a => a.chatgptAccountId === accountId);
  if (!rereadAccount) return null;
  if (rereadAccount.state !== 'active') return null;
  if (rereadAccount.refresh_token === usedRefreshToken) return null;
  log?.log('chatgpt_refresh_race_recovered', { upstream_id: upstreamId, account_id: accountId });
  if (rereadAccount.accessToken && isAccessTokenUsable(rereadAccount.accessToken, rereadAccount.refresh_token !== null)) {
    return { ok: true, value: rereadAccount.accessToken };
  }
  // Sibling rotated the refresh token but no usable access token sits in
  // state — most likely an `invalidateChatGPTAccessToken` ran between the
  // sibling's rotation and our re-read. Re-enter the refresh flow once with
  // the live RT; the re-entrant call sees the rotated row and goes straight
  // through the standard mint path. The depth guard suppresses a second
  // recovery attempt — if `invalid_grant` strikes again the refresh token
  // really is dead and we want the terminal flip.
  return await ensureAccessToken(upstreamId, rereadAccount, mint, false, false, log);
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
  const result = await persistMint(await refreshChatGPTAccessToken(refreshToken, fetcher), persistRefreshTokenRotation);
  if (!result.ok) throw result.error;
  return result.value;
};

export const mintChatGPTAccessTokenResult = async (
  refreshToken: string,
  fetcher: ChatGPTOAuthFetcher,
  persistRefreshTokenRotation: (newRefreshToken: string) => Promise<void>,
): ReturnType<ChatGPTAccessTokenMint> => {
  const result = await refreshChatGPTAccessTokenResult(refreshToken, fetcher);
  return result.ok ? await persistMint(result.value, persistRefreshTokenRotation) : result;
};

const persistMint = async (
  tokens: ChatGPTOAuthRefreshTokens,
  persistRefreshTokenRotation: (newRefreshToken: string) => Promise<void>,
): Promise<Result<ChatGPTAccessTokenEntry, ChatGPTOAuthResponseError>> => {
  await persistRefreshTokenRotation(tokens.refresh_token);
  const plan = tokens.id_token === undefined ? { ok: true, value: undefined } as const : parseChatGPTIdTokenPlanType(tokens.id_token);
  if (!plan.ok) {
    const message = plan.error.message;
    return {
      ok: false, error: new ChatGPTOAuthResponseError(message, {
        status: 502,
        statusText: 'Bad Gateway',
        headers: [['content-type', 'application/json']],
        body: { error: { type: 'server_error', message } },
      }),
    };
  }
  const { value: planType } = plan;
  const refreshedAt = new Date().toISOString();
  return {
    ok: true, value: {
      token: tokens.access_token,
      expiresAt: chatgptTokenExpiresAt(tokens.expires_in),
      refreshedAt,
      ...(planType === undefined ? {} : { planType, planObservedAt: refreshedAt }),
    },
  };
};
