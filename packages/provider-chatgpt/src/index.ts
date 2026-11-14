import { CHATGPT_DEFAULT_FLAGS } from './defaults.ts';
import { createChatGPTProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';
export { createChatGPTPipelines } from './pipelines.ts';

export const chatgptProviderModule: ProviderModule = {
  create: createChatGPTProvider,
  defaultFlags: CHATGPT_DEFAULT_FLAGS,
};

export * from './access-token.ts';
export * from './auth/credential.ts';
export * from './auth/import.ts';
export * from './auth/oauth.ts';
export * from './constants.ts';
export * from './config.ts';
export * from './state.ts';
export * from './quota.ts';
export * from './rate-limit-resets.ts';
export { pricingForChatGPTModelKey } from './pricing.ts';
export { chatgptModelContextWindow, type ChatGPTContextWindow } from './models.ts';
