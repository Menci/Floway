import { ChatGPTTokenClaimsError, parseChatGPTIdTokenPlanType } from './auth/jwt.ts';
import { ChatGPTOAuthResponseError, chatgptTokenExpiresAt, refreshChatGPTAccessToken, type ChatGPTOAuthRefreshTokens } from './auth/oauth.ts';
import type { ChatGPTAccessTokenEntry } from './state.ts';
import type { Fetcher } from '@floway-dev/provider';

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
export const isAccessTokenUsable = (entry: ChatGPTAccessTokenEntry, renewable: boolean): boolean => {
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

export const mergeChatGPTAccessTokenEntry = (
  incoming: ChatGPTAccessTokenEntry,
  current: ChatGPTAccessTokenEntry | null | undefined,
  fallbackPlan: ChatGPTPlanObservation | undefined,
): ChatGPTAccessTokenEntry => {
  const incomingTime = Date.parse(incoming.refreshedAt);
  const currentTime = current === null || current === undefined ? Number.NEGATIVE_INFINITY : Date.parse(current.refreshedAt);
  const token = Number.isFinite(currentTime) && (!Number.isFinite(incomingTime) || currentTime > incomingTime)
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

export const chatgptAccessTokenFromRefresh = (tokens: ChatGPTOAuthRefreshTokens): ChatGPTAccessTokenEntry => {
  let planType;
  try {
    planType = tokens.id_token === undefined ? undefined : parseChatGPTIdTokenPlanType(tokens.id_token);
  } catch (error) {
    if (!(error instanceof ChatGPTTokenClaimsError)) throw error;
    throw new ChatGPTOAuthResponseError(error.message, { cause: error });
  }
  const refreshedAt = new Date().toISOString();
  return {
    token: tokens.access_token,
    expiresAt: chatgptTokenExpiresAt(tokens.expires_in),
    refreshedAt,
    ...(planType === undefined ? {} : { planType, planObservedAt: refreshedAt }),
  };
};

export const mintChatGPTAccessToken = async (
  refreshToken: string,
  fetcher: Fetcher,
  persistRefreshTokenRotation: (newRefreshToken: string) => Promise<void>,
): Promise<ChatGPTAccessTokenEntry> => {
  const tokens = await refreshChatGPTAccessToken(refreshToken, fetcher);
  // The issuer has already rotated the credential before plan metadata can be decoded.
  await persistRefreshTokenRotation(tokens.refresh_token);
  return chatgptAccessTokenFromRefresh(tokens);
};
