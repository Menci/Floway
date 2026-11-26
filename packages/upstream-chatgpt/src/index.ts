import { CHATGPT_DEFAULT_FLAGS } from './defaults.ts';
import { createChatGPTUpstream } from './upstream.ts';
import type { UpstreamModule } from '@floway-dev/upstream';

export const chatgptUpstreamModule: UpstreamModule = {
  create: createChatGPTUpstream,
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
