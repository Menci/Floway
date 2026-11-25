export { exchangeCopilotToken } from './auth.ts';
export { COPILOT_DEFAULT_FLAGS } from './defaults.ts';
export { copilotPipelines } from './pipelines/index.ts';
export { runCopilotScheduledTask } from './scheduled.ts';
export { createCopilotService, getCopilotProvidedModels, type CopilotService, type CopilotServices } from './service.ts';

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
  copilotUpstreamFact,
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
