import { ChatGPTAccessOnlyCredentialError, chatgptPlanObservation, createChatGPTAccessTokenEnsurer, invalidateChatGPTAccessToken, mintChatGPTAccessToken, type ChatGPTAccessTokenLog, type ChatGPTPlanObservation } from './access-token.ts';
import { ChatGPTOAuthSessionTerminatedError } from './auth/oauth.ts';
import type { ChatGPTUpstream } from './config.ts';
import { chatgptPlanSupportsImages } from './models.ts';
import { clearChatGPTQuota, hasChatGPTQuotaReading, parseChatGPTQuotaHeaders, putChatGPTQuota } from './quota.ts';
import { consumeChatGPTRateLimitResetCredit, fetchChatGPTRateLimitResetCredits } from './rate-limit-resets.ts';
import { persistChatGPTRefreshTokenRotation, persistChatGPTTerminalState, readChatGPTUpstreamState, type ChatGPTAccessTokenEntry } from './state.ts';
import type { Fetcher, HttpHeaders } from '@floway-dev/http';
import { Secret } from '@floway-dev/pipeline';
import { getProviderRepo, type ProviderServices } from '@floway-dev/provider';

export interface ChatGPTAccessError {
  status: 403 | 503;
  type: 'image_tools_unavailable' | 'chatgpt_upstream_unavailable';
  message: string;
}

export type ChatGPTAuthorization =
  | { kind: 'authorized'; bearer: Secret<string>; installationId: string; reject(error: { code: string | null; message: string }): ChatGPTUnauthorized }
  | { kind: 'unavailable'; error: ChatGPTAccessError };

export type ChatGPTUnauthorized =
  | { kind: 'access-only'; persist(): Promise<void> }
  | { kind: 'terminated'; error: ChatGPTAccessError; persist(): Promise<void> }
  | { kind: 'renewable'; refresh(): Promise<ChatGPTAuthorization> };

interface ChatGPTAuthorizationOptions {
  images: boolean;
  log: ChatGPTAccessTokenLog;
  installationId?: string | null;
}

export interface ChatGPTService {
  authorize(upstream: ChatGPTUpstream, fetcher: Fetcher, options: ChatGPTAuthorizationOptions): Promise<ChatGPTAuthorization>;
  ensureAccessToken: ReturnType<typeof createChatGPTAccessTokenEnsurer>;
  quotaObservation(upstream: ChatGPTUpstream, headers: HttpHeaders, status: number, whenPresent: boolean): (() => Promise<void>) | null;
  listRateLimitResetCredits: typeof fetchChatGPTRateLimitResetCredits;
  consumeRateLimitResetCredit: typeof consumeChatGPTRateLimitResetCredit;
  clearQuota: typeof clearChatGPTQuota;
}

export interface ChatGPTServices extends ProviderServices {
  chatgpt: ChatGPTService;
}

const unavailable = (message: string): ChatGPTAccessError => ({ status: 503, type: 'chatgpt_upstream_unavailable', message });

const mergeRetryPlan = (entry: ChatGPTAccessTokenEntry, prior: ChatGPTPlanObservation | null): ChatGPTAccessTokenEntry =>
  entry.planType !== undefined || prior === null ? entry : {
    ...entry,
    planType: prior.planType,
    ...(prior.observedAt === undefined ? {} : { planObservedAt: prior.observedAt }),
  };

export const createChatGPTService = (): ChatGPTService => {
  const ensureAccessToken = createChatGPTAccessTokenEnsurer();

  const authorize = async (upstream: ChatGPTUpstream, fetcher: Fetcher, options: ChatGPTAuthorizationOptions): Promise<ChatGPTAuthorization> => {
    const { chatgptAccountId: accountId, planType } = upstream.config.accounts[0];
    const fresh = await getProviderRepo().upstreams.getById(upstream.id);
    if (!fresh) throw new Error(`ChatGPT upstream ${upstream.id} disappeared mid-request`);
    const account = readChatGPTUpstreamState(fresh.state).accounts.find(value => value.chatgptAccountId === accountId);
    if (!account) throw new Error(`ChatGPT upstream ${upstream.id} state has no credential for account ${accountId}`);
    if (account.state !== 'active') return { kind: 'unavailable', error: unavailable(`ChatGPT upstream is ${account.state}`) };

    const mint = (token: string) => mintChatGPTAccessToken(token, fetcher, rotated =>
      persistChatGPTRefreshTokenRotation(upstream.id, accountId, rotated, { onMissing: 'throw' }));
    const persistTerminal = (state: 'session_terminated' | 'refresh_failed', message: string) =>
      persistChatGPTTerminalState(upstream.id, accountId, state, message, { onMissing: 'throw' });

    const issue = async (failed?: ChatGPTAccessTokenEntry, priorPlan: ChatGPTPlanObservation | null = null): Promise<ChatGPTAuthorization> => {
      let access: ChatGPTAccessTokenEntry;
      try {
        const retained = failed === undefined ? null : await invalidateChatGPTAccessToken(upstream.id, accountId, failed.token);
        access = retained ?? await ensureAccessToken(upstream.id, accountId, async token => mergeRetryPlan(await mint(token), priorPlan), failed !== undefined, options.log);
      } catch (error) {
        if (error instanceof ChatGPTOAuthSessionTerminatedError) {
          await persistTerminal('refresh_failed', error.upstreamMessage);
          return { kind: 'unavailable', error: unavailable(`ChatGPT refresh failed: ${error.upstreamMessage}`) };
        }
        if (error instanceof ChatGPTAccessOnlyCredentialError) return { kind: 'unavailable', error: unavailable(error.message) };
        throw error;
      }

      const plan = chatgptPlanObservation(access) ?? priorPlan ?? (planType === null ? null : { planType });
      if (options.images && plan !== null && !chatgptPlanSupportsImages(plan.planType)) {
        return {
          kind: 'unavailable', error: {
            status: 403, type: 'image_tools_unavailable', message: 'ChatGPT Free accounts do not provide Codex image tools.',
          },
        };
      }

      return {
        kind: 'authorized',
        bearer: Secret.from(access.token).map(token => `Bearer ${token}`),
        installationId: options.installationId ?? account.openaiDeviceId,
        reject({ code, message }) {
          const persist = () => persistTerminal('session_terminated', message);
          if (account.refresh_token === null) return { kind: 'access-only', persist };
          // https://github.com/openai/codex/blob/87b808bb570f01f4b6fc8485c5459052fac0e320/codex-rs/login/src/auth/manager.rs
          if (code === 'token_invalidated') return { kind: 'terminated', error: unavailable(`ChatGPT session terminated: ${message}`), persist };
          return { kind: 'renewable', refresh: () => issue(access, options.images ? plan : chatgptPlanObservation(access)) };
        },
      };
    };

    return await issue();
  };

  return {
    authorize,
    ensureAccessToken,
    quotaObservation(upstream, headers, status, whenPresent) {
      const observed = new Headers();
      for (const [key, value] of headers) {
        if (typeof value === 'string') observed.append(key, value);
      }
      const snapshot = parseChatGPTQuotaHeaders(observed, { now: new Date(), isRateLimited: status === 429 });
      if (whenPresent && !hasChatGPTQuotaReading(snapshot)) return null;
      return () => putChatGPTQuota(upstream.id, upstream.config.accounts[0].chatgptAccountId, snapshot);
    },
    listRateLimitResetCredits: fetchChatGPTRateLimitResetCredits,
    consumeRateLimitResetCredit: consumeChatGPTRateLimitResetCredit,
    clearQuota: clearChatGPTQuota,
  };
};

export const ensureChatGPTAccessToken = (service: ChatGPTService, ...args: Parameters<ChatGPTService['ensureAccessToken']>) =>
  service.ensureAccessToken(...args);
