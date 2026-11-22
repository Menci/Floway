import { CHATGPT_DEFAULT_FLAGS } from './defaults.ts';
import { createChatGPTProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

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
export { chatgptCodexModelMetadata, type ChatGPTCodexModelMetadata } from './models.ts';
export { createChatGPTPipelines } from './pipelines.ts';
export { chatgptStateEffects, type ChatGPTStateEffects } from './effects.ts';
export { defaultChatGPTInstructions } from './responses-instructions.ts';
export { stripChatGPTUnsupportedFields } from './responses-fields.ts';
