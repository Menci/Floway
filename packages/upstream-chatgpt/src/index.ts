import { getChatGPTModels } from './catalog.ts';
import { CHATGPT_DEFAULT_FLAGS } from './defaults.ts';
import { runChatGPTScheduledTask } from './usage-probe.ts';
import type { UpstreamModule } from '@floway-dev/upstream';

export const chatgptUpstreamModule = {
  defaultFlags: CHATGPT_DEFAULT_FLAGS,
  getModels: getChatGPTModels,
  runScheduledTask: runChatGPTScheduledTask,
} satisfies UpstreamModule;

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
export { chatgptPipelines } from './pipelines/index.ts';
export { createChatGPTService, type ChatGPTService, type ChatGPTServices } from './service.ts';
