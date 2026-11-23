import { toChatGPTUpstreamFacts } from './config.ts';
import { CHATGPT_DEFAULT_FLAGS } from './defaults.ts';
import { chatgptImageProviderModel, chatgptPlanSupportsImages, chatgptRawToProviderModel, fetchChatGPTCatalog } from './models.ts';
import { chatgptService } from './service.ts';
import { resolveEffectiveFlags, type Provider, type UpstreamRecord } from '@floway-dev/provider';

export const createChatGPTProvider = (record: UpstreamRecord): Provider => {
  const upstream = toChatGPTUpstreamFacts(record);
  const accountId = upstream.config.account.chatgptAccountId;
  const enabledFlags = resolveEffectiveFlags([CHATGPT_DEFAULT_FLAGS, record.flagOverrides]);

  return {
    upstreamId: record.id,
    kind: 'chatgpt',
    name: record.name,
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    instance: {
      runScheduledTask: options => chatgptService.runScheduledTask(upstream, options),
      getProvidedModels: async fetcher => {
        const access = await chatgptService.access({ upstream, fetcher, now: Date.now(), operation: 'control' });
        if (access.kind === 'error') {
          const persisted = await access.terminal;
          if (persisted?.persisted === false) console.warn('ChatGPT could not persist terminal state', persisted.error);
          throw access.error;
        }
        const raw = await fetchChatGPTCatalog({ accessToken: access.token.reveal(), accountId, fetcher });
        const models = raw.map(item => chatgptRawToProviderModel(item, enabledFlags));
        if (chatgptPlanSupportsImages(access.planType ?? undefined)) models.push(chatgptImageProviderModel(enabledFlags));
        return models;
      },
    },
  };
};
