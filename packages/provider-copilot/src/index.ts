import { assertCopilotUpstreamRecord } from './config.ts';
import { COPILOT_DEFAULT_FLAGS } from './defaults.ts';
import { createCopilotProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const copilotProviderModule: ProviderModule = {
  create: createCopilotProvider,
  modelCatalogIdentity: record => {
    const upstream = assertCopilotUpstreamRecord(record);
    return { githubHost: upstream.config.githubHost, userId: upstream.config.user.id };
  },
  modelRequestIdentity: record => {
    const upstream = assertCopilotUpstreamRecord(record);
    return upstream.config;
  },
  defaultFlags: COPILOT_DEFAULT_FLAGS,
};

export {
  clearInProcessCopilotTokenCache,
  exchangeCopilotToken,
} from './auth.ts';
export { fetchGitHubUser, pollGitHubDeviceFlow, startGitHubDeviceFlow } from './github-device-flow.ts';
export { normalizeGitHubHost } from './github-host.ts';
export {
  fetchCopilotUsage,
  projectCopilotUsageResponse,
  putCopilotQuota,
  type CopilotQuotaDetail,
  type CopilotQuotaSnapshot,
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
  type CopilotTokenEntry,
  type CopilotUpstreamState,
} from './state.ts';
