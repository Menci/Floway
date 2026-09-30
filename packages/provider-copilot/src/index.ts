import { COPILOT_DEFAULT_FLAGS } from './defaults.ts';
import { createCopilotProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const copilotProviderModule: ProviderModule = {
  create: createCopilotProvider,
  // https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/thinking/common/thinking.ts#L6-L23
  defaultChatCompletionsReasoning: { text: 'reasoning-text', data: 'reasoning-opaque' },
  defaultFlags: COPILOT_DEFAULT_FLAGS,
};

export {
  clearInProcessCopilotTokenCache,
  exchangeCopilotToken,
} from './auth.ts';
export { fetchGitHubUser, pollGitHubDeviceFlow, startGitHubDeviceFlow } from './github-device-flow.ts';
export { normalizeGitHubHost } from './github-host.ts';
export { pricingForCopilotPublicModelId } from './pricing.ts';
export {
  fetchCopilotUsage,
  projectCopilotSeat,
  projectCopilotUsageResponse,
  putCopilotQuota,
  putCopilotSeat,
  type CopilotQuotaDetail,
  type CopilotQuotaSnapshot,
  type CopilotSeat,
  type CopilotUsageResponse,
} from './quota.ts';
export {
  assertCopilotUpstreamRecord,
  parseCopilotUpstreamConfig,
  type CopilotUpstreamConfig,
  type CopilotUpstreamUser,
} from './config.ts';
export {
  assertCopilotUpstreamState,
  emptyCopilotUpstreamState,
  readCopilotUpstreamState,
  type CopilotQuotaSnapshotEntry,
  type CopilotSeatEntry,
  type CopilotTokenEntry,
  type CopilotUpstreamState,
} from './state.ts';
