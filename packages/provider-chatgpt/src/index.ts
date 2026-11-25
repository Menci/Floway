import { CHATGPT_DEFAULT_FLAGS } from './defaults.ts';
import { createChatGPTProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const chatgptProviderModule: ProviderModule = {
  create: createChatGPTProvider,
  defaultFlags: CHATGPT_DEFAULT_FLAGS,
};

export { ChatGPTAccessOnlyCredentialError, chatgptPlanObservation, invalidateChatGPTAccessToken, mintChatGPTAccessToken, putChatGPTAccessToken, type ChatGPTAccessTokenEntry, type ChatGPTPlanObservation } from './access-token.ts';
export * from './auth/credential.ts';
export * from './auth/import.ts';
export * from './auth/oauth.ts';
export * from './constants.ts';
export * from './config.ts';
export * from './state.ts';
export * from './quota.ts';
export * from './rate-limit-resets.ts';
export { getChatGPTProvidedModels } from './catalog.ts';
export { CHATGPT_DEFAULT_FLAGS } from './defaults.ts';
export { chatgptPipelines } from './pipelines/index.ts';
export { createChatGPTService, ensureChatGPTAccessToken, type ChatGPTService, type ChatGPTServices } from './service.ts';
export { runChatGPTScheduledTask } from './usage-probe.ts';
export { chatgptUpstreamFact, type ChatGPTUpstreamFact } from './upstream-fact.ts';
export { pricingForChatGPTModelKey } from './pricing.ts';
export { chatgptCodexModelMetadata, type ChatGPTCodexModelMetadata } from './models.ts';
