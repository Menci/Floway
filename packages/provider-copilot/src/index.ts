import { COPILOT_DEFAULT_FLAGS } from './defaults.ts';
import { createCopilotProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const copilotProviderModule: ProviderModule = {
  create: createCopilotProvider,
  defaultFlags: COPILOT_DEFAULT_FLAGS,
};

export {
  clearInProcessCopilotTokenCache,
  exchangeCopilotToken,
} from './auth.ts';
export { fetchGitHubUser, pollGitHubDeviceFlow, startGitHubDeviceFlow } from './github-device-flow.ts';
export { fetchCopilotUsage, type CopilotUsageResponse } from './quota.ts';
export {
  type CopilotUpstreamConfig,
  type CopilotUpstreamUser,
} from './config.ts';
export {
  emptyCopilotUpstreamState,
  readCopilotUpstreamState,
  type CopilotTokenEntry,
  type CopilotUpstreamState,
} from './state.ts';
