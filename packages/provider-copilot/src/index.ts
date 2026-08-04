import { COPILOT_DEFAULT_FLAGS } from './defaults.ts';
import { createCopilotProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const copilotProviderModule: ProviderModule = {
  create: createCopilotProvider,
  // Copilot's Messages boundary consumes this value for raw-variant selection
  // and emits only its supported subset on the wire.
  // https://github.com/microsoft/vscode/blob/a234109a108ad2ca78b7d0883688b0a84e3fab42/extensions/copilot/src/extension/chatSessions/claude/node/claudeLanguageModelServer.ts#L413-L427
  inboundHeaderAllowlist: {
    callMessages: ['anthropic-beta'],
    callMessagesCountTokens: ['anthropic-beta'],
  },
  defaultFlags: COPILOT_DEFAULT_FLAGS,
};

export {
  clearInProcessCopilotTokenCache,
  exchangeCopilotToken,
} from './auth.ts';
export { fetchGitHubUser, pollGitHubDeviceFlow, startGitHubDeviceFlow } from './github-device-flow.ts';
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
