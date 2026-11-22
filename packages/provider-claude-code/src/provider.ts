import { ensureClaudeCodeAccessToken } from './access-token.ts';
import { assertClaudeCodeUpstreamRecord } from './config.ts';
import { CLAUDE_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { buildClaudeCodeCatalog, fetchClaudeCodeModelsList } from './models.ts';
import { createClaudeCodePipelines } from './pipelines.ts';
import { runClaudeCodeScheduledTask } from './scheduled.ts';
import { assertClaudeCodeUpstreamState } from './state.ts';
import {
  getProviderRepo,
  resolveEffectiveFlags,
  type Provider,
  type ProviderInstance,
  type UpstreamRecord,
} from '@floway-dev/provider';

// sub2api's gateway forwards this Claude Code fingerprint set.
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L421-L444
const INBOUND_HEADER_ALLOWLIST = [
  'accept',
  /^x-stainless-(?:retry-count|timeout|lang|package-version|os|arch|runtime|runtime-version|helper-method)$/,
  'anthropic-dangerous-direct-browser-access',
  'anthropic-version',
  'x-app',
  'accept-language',
  'sec-fetch-mode',
  'user-agent',
  'content-type',
  'accept-encoding',
  'x-claude-code-session-id',
  'x-client-request-id',
] as const;

export const createClaudeCodeProvider = (record: UpstreamRecord): Provider => {
  assertClaudeCodeUpstreamRecord(record);
  assertClaudeCodeUpstreamState(record.state);
  const enabledFlags = resolveEffectiveFlags([CLAUDE_CODE_DEFAULT_FLAGS, record.flagOverrides]);

  const instance: ProviderInstance = {
    runScheduledTask: options => runClaudeCodeScheduledTask(record, options),
    getProvidedModels: async fetcher => {
      const access = await ensureClaudeCodeAccessToken({
        upstreamId: record.id,
        repo: getProviderRepo().upstreams,
        fetcher,
      });
      const models = await fetchClaudeCodeModelsList(access.entry.token, fetcher);
      return buildClaudeCodeCatalog(models, enabledFlags);
    },
  };

  return {
    upstreamId: record.id,
    kind: 'claude-code',
    name: record.name,
    inboundHeaderAllowlist: INBOUND_HEADER_ALLOWLIST,
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    pipelines: createClaudeCodePipelines(record),
    instance,
  };
};
