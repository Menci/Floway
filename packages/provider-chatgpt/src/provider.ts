import { ensureChatGPTAccessToken, mintChatGPTAccessToken } from './access-token.ts';
import { ChatGPTOAuthSessionTerminatedError } from './auth/oauth.ts';
import { assertChatGPTUpstreamRecord } from './config.ts';
import { CHATGPT_DEFAULT_FLAGS } from './defaults.ts';
import { chatgptStateEffects } from './effects.ts';
import { chatgptImageProviderModel, chatgptPlanSupportsImages, chatgptRawToProviderModel, fetchChatGPTCatalog } from './models.ts';
import { createChatGPTPipelines } from './pipelines.ts';
import { assertChatGPTUpstreamState } from './state.ts';
import { runChatGPTScheduledTask } from './usage-probe.ts';
import {
  resolveEffectiveFlags,
  type Provider,
  type ProviderInstance,
  type UpstreamRecord,
} from '@floway-dev/provider';

// These are the Codex client headers our ChatGPT boundary understands. The
// identity headers are projected into Codex metadata before dispatch.
// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/requests/headers.rs#L5-L12
// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/endpoint/responses.rs#L87-L96
// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/core/src/responses_metadata.rs#L255-L270
// https://github.com/openai/codex/blob/bd8fc9adb93fa5bc0a69b396bd5ac78a5ec14487/codex-rs/codex-api/src/requests/headers.rs#L5-L16
// https://github.com/openai/codex/blob/646f7c0a91b8e327d263335da68ae8ef212895ce/codex-rs/ext/image-generation/src/backend.rs#L81-L89
const INBOUND_HEADER_ALLOWLIST = [
  'originator',
  'session-id',
  'session_id',
  'thread-id',
  'x-client-request-id',
  'x-codex-image-turn-id',
  'x-codex-turn-metadata',
  'x-codex-window-id',
] as const;

export const createChatGPTProvider = (record: UpstreamRecord): Provider => {
  assertChatGPTUpstreamRecord(record);
  assertChatGPTUpstreamState(record.state);
  const account = record.config.accounts[0];
  const effects = chatgptStateEffects(record.id, account.chatgptAccountId);
  const enabledFlags = resolveEffectiveFlags([CHATGPT_DEFAULT_FLAGS, record.flagOverrides]);

  const instance: ProviderInstance = {
    runScheduledTask: options => runChatGPTScheduledTask(record, options),
    getProvidedModels: async fetcher => {
      let access;
      try {
        access = await ensureChatGPTAccessToken(record.id, account.chatgptAccountId, refreshToken =>
          mintChatGPTAccessToken(refreshToken, fetcher, effects.persistRefreshTokenRotation));
      } catch (error) {
        if (error instanceof ChatGPTOAuthSessionTerminatedError) {
          await effects.persistTerminalState('refresh_failed', error.upstreamMessage);
        }
        throw error;
      }
      const raw = await fetchChatGPTCatalog({
        accessToken: access.token,
        accountId: account.chatgptAccountId,
        fetcher,
      });
      // Hidden catalog entries remain dispatchable through the gateway, so we
      // expose every upstream model and let per-upstream flags control access.
      const models = raw.map(model => chatgptRawToProviderModel(model, enabledFlags));
      if (chatgptPlanSupportsImages(access.planType ?? account.planType ?? undefined)) {
        models.push(chatgptImageProviderModel(enabledFlags));
      }
      return models;
    },
  };

  return {
    upstreamId: record.id,
    kind: 'chatgpt',
    name: record.name,
    inboundHeaderAllowlist: INBOUND_HEADER_ALLOWLIST,
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    pipelines: createChatGPTPipelines({
      upstreamId: record.id,
      accountId: account.chatgptAccountId,
      fallbackPlanType: account.planType ?? undefined,
    }),
    instance,
  };
};
