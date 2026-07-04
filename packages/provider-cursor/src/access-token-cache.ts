import { CursorSessionTerminatedError, refreshCursorAccessToken } from './auth/oauth.ts';
import { readCursorUpstreamState, type CursorAccessTokenEntry, type CursorUpstreamState } from './state.ts';
import { getProviderRepo, type Fetcher } from '@floway-dev/provider';

export type { CursorAccessTokenEntry };

// Refresh window: a cached token within this much of expiry counts as
// already-expired so the next call mints a fresh one rather than racing the
// upstream clock.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const isAccessTokenFresh = (entry: CursorAccessTokenEntry): boolean =>
  entry.expiresAt > Date.now() + REFRESH_SKEW_MS;

const findAccountIndex = (state: CursorUpstreamState, userId: string): number =>
  state.accounts.findIndex(a => a.userId === userId);

const replaceAccountAccessToken = (
  state: CursorUpstreamState,
  index: number,
  entry: CursorAccessTokenEntry | null,
): CursorUpstreamState => ({
  ...state,
  accounts: state.accounts.map((account, i) => (i === index ? { ...account, accessToken: entry } : account)),
});

// A losing CAS is not an error — saveState reports it via `updated: false`,
// and the next call re-reads state and refreshes if needed. Genuine storage
// failures propagate.
const persistAccessToken = async (
  upstreamId: string,
  userId: string,
  entry: CursorAccessTokenEntry | null,
  where: string,
): Promise<void> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) {
    console.warn(`${where}: Cursor upstream ${upstreamId} disappeared mid-request`);
    return;
  }
  const state = readCursorUpstreamState(fresh.state);
  const idx = findAccountIndex(state, userId);
  if (idx < 0) {
    console.warn(`${where}: Cursor account ${userId} not found in upstream ${upstreamId}`);
    return;
  }
  if (entry === null && state.accounts[idx]!.accessToken === null) return;
  const next = replaceAccountAccessToken(state, idx, entry);
  await getProviderRepo().upstreams.saveState(upstreamId, next, { expectedState: fresh.state });
};

// Reads, mints, and persists. Refresh-race recovery: Cursor's refresh endpoint
// returns 401/403 for both a genuinely dead refresh_token AND a sibling-won
// rotation (our copy is now stale). recoverFromRefreshRace re-reads state and
// compares the refresh token; if a sibling rotated, we use their cached access
// token. If nothing moved, the session is really dead and we re-raise.
export const ensureCursorAccessToken = async (
  upstreamId: string,
  userId: string,
  mint: (refreshToken: string) => Promise<CursorAccessTokenEntry>,
  recoveryAllowed = true,
): Promise<CursorAccessTokenEntry> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) throw new Error(`Cursor upstream ${upstreamId} not found`);
  const state = readCursorUpstreamState(fresh.state);
  const account = state.accounts.find(a => a.userId === userId);
  if (!account) throw new Error(`Cursor account ${userId} not found in upstream ${upstreamId}`);
  if (account.accessToken && isAccessTokenFresh(account.accessToken)) {
    return account.accessToken;
  }

  let minted;
  try {
    minted = await mint(account.refresh_token);
  } catch (err) {
    if (err instanceof CursorSessionTerminatedError && recoveryAllowed) {
      const recovered = await recoverFromRefreshRace(upstreamId, userId, account.refresh_token, mint);
      if (recovered) return recovered;
    }
    throw err;
  }
  await persistAccessToken(upstreamId, userId, minted, 'ensureCursorAccessToken');
  return minted;
};

const recoverFromRefreshRace = async (
  upstreamId: string,
  userId: string,
  usedRefreshToken: string,
  mint: (refreshToken: string) => Promise<CursorAccessTokenEntry>,
): Promise<CursorAccessTokenEntry | null> => {
  const reread = await getProviderRepo().upstreams.getById(upstreamId);
  if (!reread) return null;
  const rereadState = readCursorUpstreamState(reread.state);
  const rereadAccount = rereadState.accounts.find(a => a.userId === userId);
  if (!rereadAccount) return null;
  if (rereadAccount.state !== 'active') return null;
  if (rereadAccount.refresh_token === usedRefreshToken) return null;
  console.info(
    `Cursor refresh-race recovered for upstream ${upstreamId} account ${userId}: sibling rotated, using their access token`,
  );
  if (rereadAccount.accessToken && isAccessTokenFresh(rereadAccount.accessToken)) {
    return rereadAccount.accessToken;
  }
  return await ensureCursorAccessToken(upstreamId, userId, mint, false);
};

// Mints a fresh access token via /auth/exchange_user_api_key and routes the
// rotated refresh_token through the caller's CAS hook.
export const mintCursorAccessToken = async (
  refreshToken: string,
  fetcher: Fetcher,
  persistRefreshTokenRotation: (newRefreshToken: string) => Promise<void>,
): Promise<CursorAccessTokenEntry> => {
  const tokens = await refreshCursorAccessToken(refreshToken, fetcher);
  await persistRefreshTokenRotation(tokens.refresh_token);
  return {
    token: tokens.access_token,
    expiresAt: tokens.expires_at,
    refreshedAt: new Date().toISOString(),
  };
};
