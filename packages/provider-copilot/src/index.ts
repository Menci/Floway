import { COPILOT_DEFAULT_FLAGS } from './defaults.ts';
import { createCopilotProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const copilotProviderModule: ProviderModule = {
  create: createCopilotProvider,
  defaultFlags: COPILOT_DEFAULT_FLAGS,
};

export { exchangeCopilotToken } from './auth.ts';
export { copilotPipelines } from './pipelines.ts';
export { clearInProcessCopilotTokenCache, createCopilotService, type CopilotService, type CopilotServices } from './service.ts';
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
  toCopilotUpstreamFacts,
  type CopilotUpstreamConfig,
  type CopilotUpstreamConfigFacts,
  type CopilotUpstreamFacts,
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
