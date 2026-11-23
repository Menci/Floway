import { CHATGPT_DEFAULT_FLAGS } from './defaults.ts';
import { createChatGPTProvider } from './provider.ts';
import { chatgptService } from './service.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const chatgptProviderModule: ProviderModule = {
  create: createChatGPTProvider,
  defaultFlags: CHATGPT_DEFAULT_FLAGS,
};

export { ChatGPTAccessOnlyCredentialError, chatgptPlanObservation, mintChatGPTAccessToken, type ChatGPTPlanObservation } from './access-token.ts';
export * from './auth/credential.ts';
export * from './auth/import.ts';
export * from './auth/oauth.ts';
export * from './constants.ts';
export * from './config.ts';
export * from './state.ts';
export * from './quota.ts';
export { chatgptPipelines } from './pipelines.ts';
export { chatgptService, createChatGPTService, type ChatGPTService, type ChatGPTServices } from './service.ts';
export * from './rate-limit-resets.ts';
export { pricingForChatGPTModelKey } from './pricing.ts';
export { chatgptCodexModelMetadata, type ChatGPTCodexModelMetadata } from './models.ts';

export const {
  clearQuota: clearChatGPTQuota,
  ensureAccessToken: ensureChatGPTAccessToken,
  getQuota: getChatGPTQuota,
  invalidateAccessToken: invalidateChatGPTAccessToken,
  persistRefreshTokenRotation: persistChatGPTRefreshTokenRotation,
  persistTerminalState: persistChatGPTTerminalState,
  putAccessToken: putChatGPTAccessToken,
  putQuota: putChatGPTQuota,
} = chatgptService;

export const persistChatGPTRefreshFailure = (upstreamId: string, accountId: string | null, message: string): Promise<void> =>
  chatgptService.persistTerminalState(upstreamId, accountId, 'refresh_failed', message);
