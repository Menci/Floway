import { ChatGPTAccessOnlyCredentialError, chatgptPlanObservation, invalidateChatGPTAccessToken, mintChatGPTAccessTokenResult, resolveChatGPTAccessToken, type ChatGPTAccessTokenMint, type ChatGPTAccessTokenResult, type ChatGPTPlanObservation, type ChatGPTTokenLog } from './access-token.ts';
import { ChatGPTOAuthResponseError, ChatGPTOAuthSessionTerminatedError, type ChatGPTOAuthFetcher } from './auth/oauth.ts';
import { chatgptPlanSupportsImages } from './models.ts';
import { hasChatGPTQuotaReading, parseChatGPTQuotaHeaders, putChatGPTQuota } from './quota.ts';
import { readChatGPTUpstreamState, persistChatGPTRefreshTokenRotation, persistChatGPTTerminalState, type ChatGPTAccessTokenEntry } from './state.ts';
import type { ChatGPTUpstreamFact } from './upstream-fact.ts';
import { materializeHeaders, type HttpHeaders, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import { Secret } from '@floway-dev/pipeline';
import { getProviderRepo, type ProviderServices } from '@floway-dev/provider';

type ChatGPTPersistence =
  | { readonly persisted: true }
  | { readonly persisted: false; readonly error: unknown };

export type ChatGPTAccessFailure =
  | { readonly kind: 'local'; readonly status: 403 | 503; readonly type: string; readonly message: string }
  | { readonly kind: 'upstream'; readonly http: HttpResponseFact }
  | { readonly kind: 'transport'; readonly http: HttpResponseFact | null; readonly error: HttpStreamError };

type ChatGPTAuthorization =
  | { readonly kind: 'authorized'; readonly bearer: Secret<string> }
  | ChatGPTAccessFailure;

type ChatGPTUnauthorized =
  | { readonly kind: 'retry' }
  | { readonly kind: 'relay'; readonly persistence?: Promise<ChatGPTPersistence> }
  | Extract<ChatGPTAccessFailure, { kind: 'local' }>;

export interface ChatGPTService {
  readonly deviceId: (upstream: ChatGPTUpstreamFact) => Promise<string>;
  readonly authorization: (upstream: ChatGPTUpstreamFact, fetcher: ChatGPTOAuthFetcher, images: boolean, log: ChatGPTTokenLog) => Promise<ChatGPTAuthorization>;
  readonly reauthorize: (upstream: ChatGPTUpstreamFact, bearer: Secret<string>, fetcher: ChatGPTOAuthFetcher, images: boolean, log: ChatGPTTokenLog) => Promise<ChatGPTAuthorization>;
  readonly observeUnauthorized: (upstream: ChatGPTUpstreamFact, bearer: Secret<string>, code: string | null, message: string) => Promise<ChatGPTUnauthorized>;
  readonly observeQuota: (upstream: ChatGPTUpstreamFact, headers: HttpHeaders, status: number, onlyWhenPresent: boolean) => Promise<ChatGPTPersistence>;
}

export interface ChatGPTServices extends ProviderServices {
  readonly chatgpt: ChatGPTService;
}

const readAccount = async (upstream: ChatGPTUpstreamFact) => {
  const identity = upstream.config.accounts[0];
  const current = await getProviderRepo().upstreams.getById(upstream.id);
  if (current === null) throw new Error(`ChatGPT upstream ${upstream.id} disappeared mid-request`);
  const account = readChatGPTUpstreamState(current.state).accounts.find(value => value.chatgptAccountId === identity.chatgptAccountId);
  if (!account) throw new Error(`ChatGPT upstream ${upstream.id} state has no credential for account ${identity.chatgptAccountId}`);
  return account;
};

const unavailable = (message: string): Extract<ChatGPTAccessFailure, { kind: 'local' }> =>
  ({ kind: 'local', status: 503, type: 'chatgpt_upstream_unavailable', message });

const persist = async (write: () => Promise<void>): Promise<ChatGPTPersistence> => {
  try {
    await write();
    return { persisted: true };
  } catch (error) {
    return { persisted: false, error };
  }
};

const mergeRetryPlan = (entry: ChatGPTAccessTokenEntry, fallbackPlan: ChatGPTPlanObservation | null): ChatGPTAccessTokenEntry =>
  entry.planType !== undefined || fallbackPlan === null ? entry : {
    ...entry,
    planType: fallbackPlan.planType,
    ...(fallbackPlan.observedAt === undefined ? {} : { planObservedAt: fallbackPlan.observedAt }),
  };

// Coalesce callers that could use the same refresh token on this isolate.
// The dashboard's forced refresh and ordinary cache reads use separate keys.
const inFlightEnsures = new Map<string, Promise<ChatGPTAccessTokenResult>>();

const ensureAccessToken = async (
  upstreamId: string,
  accountId: string | null,
  mint: ChatGPTAccessTokenMint,
  force: boolean,
  log?: ChatGPTTokenLog,
): Promise<ChatGPTAccessTokenResult> => {
  const key = JSON.stringify([upstreamId, accountId, force]);
  const existing = inFlightEnsures.get(key);
  if (existing) return await existing;
  const pending = resolveChatGPTAccessToken(upstreamId, accountId, mint, force, log);
  inFlightEnsures.set(key, pending);
  try {
    return await pending;
  } finally {
    inFlightEnsures.delete(key);
  }
};

export const ensureChatGPTAccessToken = async (
  upstreamId: string,
  accountId: string | null,
  mint: (refreshToken: string) => Promise<ChatGPTAccessTokenEntry>,
  force = false,
): Promise<ChatGPTAccessTokenEntry> => {
  const result = await ensureAccessToken(upstreamId, accountId, async refreshToken => {
    try {
      return { ok: true, value: await mint(refreshToken) };
    } catch (error) {
      if (error instanceof ChatGPTOAuthResponseError) return { ok: false, error };
      throw error;
    }
  }, force);
  if (!result.ok) throw result.error instanceof ChatGPTOAuthResponseError ? result.error : result.error.transport.cause;
  return result.value;
};

export const createChatGPTService = (): ChatGPTService => {
  // Capture the credential disposition for this exact bearer. A concurrent
  // refresh can publish a different account observation while a request runs.
  const issued = new WeakMap<Secret<string>, { readonly renewable: boolean; readonly plan: ChatGPTPlanObservation | null }>();

  const authorize = async (
    upstream: ChatGPTUpstreamFact, fetcher: ChatGPTOAuthFetcher, images: boolean, log: ChatGPTTokenLog, rejected?: Secret<string>,
  ): Promise<ChatGPTAuthorization> => {
    const { chatgptAccountId: accountId, planType } = upstream.config.accounts[0];
    const account = await readAccount(upstream);
    if (account.state !== 'active') return unavailable(`ChatGPT upstream is ${account.state}`);

    try {
      const previousPlan = rejected === undefined ? null : issued.get(rejected)!.plan;
      const mint: ChatGPTAccessTokenMint = async refreshToken => {
        const result = await mintChatGPTAccessTokenResult(
          refreshToken, fetcher, rotated => persistChatGPTRefreshTokenRotation(upstream.id, accountId, rotated, { onMissing: 'throw' }),
        );
        return result.ok ? { ok: true, value: mergeRetryPlan(result.value, previousPlan) } : result;
      };
      const retained = rejected === undefined ? null : await invalidateChatGPTAccessToken(upstream.id, accountId, rejected.reveal().slice('Bearer '.length));
      const result = retained === null
        ? await ensureAccessToken(upstream.id, accountId, mint, rejected !== undefined, log)
        : { ok: true, value: retained } as const;
      if (!result.ok) {
        const { error } = result;
        if (error instanceof ChatGPTOAuthSessionTerminatedError) {
          await persistChatGPTTerminalState(upstream.id, accountId, 'refresh_failed', error.upstreamMessage, { onMissing: 'throw' });
        }
        if (!(error instanceof ChatGPTOAuthResponseError)) return { kind: 'transport', http: error.http, error: error.transport };
        if (error.http === undefined) throw error;
        return { kind: 'upstream', http: error.http };
      }
      const access = result.value;
      const plan = chatgptPlanObservation(access) ?? previousPlan ?? (planType === null ? null : { planType });
      if (images && plan !== null && !chatgptPlanSupportsImages(plan.planType)) {
        return { kind: 'local', status: 403, type: 'image_tools_unavailable', message: 'ChatGPT Free accounts do not provide Codex image tools.' };
      }

      const bearer = Secret.from(access.token).map(token => `Bearer ${token}`);
      issued.set(bearer, { renewable: account.refresh_token !== null, plan });
      return { kind: 'authorized', bearer };
    } catch (cause) {
      if (cause instanceof ChatGPTAccessOnlyCredentialError) return unavailable(cause.message);
      throw cause;
    }
  };

  return {
    async deviceId(upstream) {
      return (await readAccount(upstream)).openaiDeviceId;
    },
    authorization: authorize,
    reauthorize: async (upstream, bearer, fetcher, images, log) => await authorize(upstream, fetcher, images, log, bearer),
    async observeUnauthorized(upstream, bearer, code, message) {
      const { chatgptAccountId: accountId } = upstream.config.accounts[0];
      const terminal = () => persistChatGPTTerminalState(upstream.id, accountId, 'session_terminated', message, { onMissing: 'throw' });
      const { renewable } = issued.get(bearer)!;
      if (!renewable) return { kind: 'relay', persistence: persist(terminal) };
      if (code !== 'token_invalidated') return { kind: 'retry' };
      await terminal();
      return unavailable(`ChatGPT session terminated: ${message}`);
    },
    observeQuota: async (upstream, headers, status, onlyWhenPresent) => await persist(async () => {
      const { chatgptAccountId: accountId } = upstream.config.accounts[0];
      const snapshot = parseChatGPTQuotaHeaders(new Headers(materializeHeaders(headers)), { now: new Date(), isRateLimited: status === 429 });
      if (onlyWhenPresent && !hasChatGPTQuotaReading(snapshot)) return;
      await putChatGPTQuota(upstream.id, accountId, snapshot);
    }),
  };
};
