import { getCopilotModels } from './catalog.ts';
import { COPILOT_DEFAULT_FLAGS } from './defaults.ts';
import { runCopilotScheduledTask } from './scheduled.ts';
import type { UpstreamModule } from '@floway-dev/upstream';

export const copilotUpstreamModule = {
  defaultFlags: COPILOT_DEFAULT_FLAGS,
  getModels: getCopilotModels,
  runScheduledTask: runCopilotScheduledTask,
} satisfies UpstreamModule;

export { copilotPipelines } from './pipelines/index.ts';
export { createCopilotServices, type CopilotService, type CopilotServices } from './service.ts';

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
