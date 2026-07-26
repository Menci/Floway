import { COPILOT_DEFAULT_FLAGS } from './defaults.ts';
import { createCopilotProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const copilotProvider: ProviderModule = {
  create: createCopilotProvider,
  defaultFlags: COPILOT_DEFAULT_FLAGS,
};

export {
  clearCopilotTokenCache,
  clearInProcessCopilotTokenCache,
  exchangeCopilotToken,
  githubHeaders,
} from './auth.ts';
export { fetchGitHubUser, pollGitHubDeviceFlow, startGitHubDeviceFlow } from './github-device-flow.ts';
export { fetchCopilotUsage, type CopilotQuotaDetail, type CopilotUsageResponse } from './quota.ts';
export {
  assertCopilotUpstreamRecord,
  type CopilotUpstreamConfig,
  type CopilotUpstreamUser,
} from './config.ts';
export {
  assertCopilotUpstreamState,
  emptyCopilotUpstreamState,
  readCopilotUpstreamState,
  type CopilotTokenEntry,
  type CopilotUpstreamState,
} from './state.ts';
