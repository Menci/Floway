import { ChatGPTAccessOnlyCredentialError, chatgptPlanObservation, ensureChatGPTAccessToken, invalidateChatGPTAccessToken, mintChatGPTAccessToken, type ChatGPTPlanObservation } from './access-token.ts';
import { ChatGPTOAuthSessionTerminatedError } from './auth/oauth.ts';
import { assertChatGPTUpstreamConfig } from './config.ts';
import { chatgptPlanSupportsImages } from './models.ts';
import { putChatGPTQuota } from './quota.ts';
import { persistChatGPTRefreshTokenRotation, persistChatGPTTerminalState, readChatGPTUpstreamState, type ChatGPTAccessTokenEntry, type ChatGPTQuotaSnapshot } from './state.ts';
import type { Fetcher } from '@floway-dev/http';
import { secret, type Secret } from '@floway-dev/pipeline';
import { getUpstreamRuntimeRepo, type UpstreamHttpServices, type UpstreamSnapshot } from '@floway-dev/upstream';

export interface ChatGPTAccessError {
  status: 403 | 503;
  type: 'image_tools_unavailable' | 'chatgpt_upstream_unavailable';
  message: string;
}

export type ChatGPTAuthorization =
  | {
    kind: 'authorized';
    bearer: Secret<string>;
    accountId: string | null;
    installationId: string;
    reject(error: { code: string | null; message: string }): ChatGPTUnauthorized;
  }
  | { kind: 'unavailable'; error: ChatGPTAccessError };

export type ChatGPTUnauthorized =
  | { kind: 'access-only'; persist(): Promise<void> }
  | { kind: 'terminated'; error: ChatGPTAccessError; persist(): Promise<void> }
  | { kind: 'renewable'; refresh(): Promise<ChatGPTAuthorization> };

export interface ChatGPTService {
  authorize(upstream: UpstreamSnapshot, fetcher: Fetcher, images: boolean): Promise<ChatGPTAuthorization>;
  observeQuota(upstream: UpstreamSnapshot, snapshot: ChatGPTQuotaSnapshot): Promise<void>;
}

export interface ChatGPTServices extends UpstreamHttpServices {
  chatgpt: ChatGPTService;
}

const accountIdentity = ({ kind, config }: UpstreamSnapshot) => {
  if (kind !== 'chatgpt') throw new TypeError(`Expected upstream kind 'chatgpt', got ${kind}`);
  assertChatGPTUpstreamConfig(config);
  return config.accounts[0];
};

const unavailable = (message: string): ChatGPTAccessError => ({
  status: 503,
  type: 'chatgpt_upstream_unavailable',
  message,
});

export const mergeRetryPlan = (
  entry: ChatGPTAccessTokenEntry,
  prior: ChatGPTPlanObservation | null | undefined,
): ChatGPTAccessTokenEntry => entry.planType !== undefined || prior == null ? entry : {
  ...entry,
  planType: prior.planType,
  ...(prior.observedAt === undefined ? {} : { planObservedAt: prior.observedAt }),
};

export const createChatGPTService = (): ChatGPTService => ({
  async authorize(upstream, fetcher, images) {
    const { chatgptAccountId: accountId, planType } = accountIdentity(upstream);
    const mint = (token: string) => mintChatGPTAccessToken(token, fetcher, rotated =>
      persistChatGPTRefreshTokenRotation(upstream.id, accountId, rotated, { onMissing: 'throw' }));
    const persistTerminal = (state: 'session_terminated' | 'refresh_failed', message: string) =>
      persistChatGPTTerminalState(upstream.id, accountId, state, message, { onMissing: 'throw' });

    const issue = async (failed?: ChatGPTAccessTokenEntry, priorPlan: ChatGPTPlanObservation | null = null): Promise<ChatGPTAuthorization> => {
      const fresh = await getUpstreamRuntimeRepo().upstreams.getById(upstream.id);
      if (!fresh) throw new Error(`ChatGPT upstream ${upstream.id} disappeared mid-request`);
      const account = readChatGPTUpstreamState(fresh.state).accounts.find(value => value.chatgptAccountId === accountId);
      if (!account) throw new Error(`ChatGPT upstream ${upstream.id} state has no credential for account ${accountId}`);
      if (account.state !== 'active') return { kind: 'unavailable', error: unavailable(`ChatGPT upstream is ${account.state}`) };

      let access: ChatGPTAccessTokenEntry;
      try {
        const retained = failed === undefined ? null : await invalidateChatGPTAccessToken(upstream.id, accountId, failed.token);
        access = retained ?? await ensureChatGPTAccessToken(upstream.id, accountId, async token =>
          mergeRetryPlan(await mint(token), priorPlan), failed !== undefined);
      } catch (error) {
        if (error instanceof ChatGPTOAuthSessionTerminatedError) {
          await persistTerminal('refresh_failed', error.upstreamMessage);
          return { kind: 'unavailable', error: unavailable(`ChatGPT refresh failed: ${error.upstreamMessage}`) };
        }
        if (error instanceof ChatGPTAccessOnlyCredentialError) return { kind: 'unavailable', error: unavailable(error.message) };
        throw error;
      }

      const plan = chatgptPlanObservation(access) ?? priorPlan ?? (planType === null ? null : { planType });
      if (images && plan !== null && !chatgptPlanSupportsImages(plan.planType)) {
        return {
          kind: 'unavailable',
          error: {
            status: 403,
            type: 'image_tools_unavailable',
            message: 'ChatGPT Free accounts do not provide Codex image tools.',
          },
        };
      }

      return {
        kind: 'authorized',
        bearer: secret(access.token).map(token => `Bearer ${token}`),
        accountId,
        installationId: account.openaiDeviceId,
        reject({ code, message }) {
          const persist = () => persistTerminal('session_terminated', message);
          if (account.refresh_token === null) return { kind: 'access-only', persist };
          // https://github.com/openai/codex/blob/87b808bb570f01f4b6fc8485c5459052fac0e320/codex-rs/login/src/auth/manager.rs
          if (code === 'token_invalidated') {
            return { kind: 'terminated', error: unavailable(`ChatGPT session terminated: ${message}`), persist };
          }
          return { kind: 'renewable', refresh: () => issue(access, images ? plan : chatgptPlanObservation(access)) };
        },
      };
    };

    return await issue();
  },
  observeQuota: (upstream, snapshot) => putChatGPTQuota(upstream.id, accountIdentity(upstream).chatgptAccountId, snapshot),
});
