import { assertClaudeCodeUpstreamRecord } from './config.ts';
import { CLAUDE_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { buildClaudeCodeCatalog, fetchClaudeCodeModelsList } from './models.ts';
import { claudeCodeService } from './service.ts';
import { assertClaudeCodeUpstreamState } from './state.ts';
import {
  resolveEffectiveFlags,
  type ProviderInstance,
  type Provider,
  type UpstreamRecord,
} from '@floway-dev/provider';

export const createClaudeCodeProvider = (record: UpstreamRecord): Provider => {
  assertClaudeCodeUpstreamRecord(record);
  assertClaudeCodeUpstreamState(record.state);

  const enabledFlags = resolveEffectiveFlags([CLAUDE_CODE_DEFAULT_FLAGS, record.flagOverrides]);

  const instance: ProviderInstance = {
    runScheduledTask: options => claudeCodeService.runScheduledTask(record, options),
    // Catalog refresh mints an access token and hits /v1/models on every
    // dispatcher poll. `ensureClaudeCodeAccessToken` flips the row to
    // `refresh_failed` and throws `ClaudeCodeOAuthSessionTerminatedError`
    // when the refresh_token has died; the throw propagates so the catalog
    // cache records the failure and surfaces it on the dashboard.
    getProvidedModels: async fetcher => {
      const access = await claudeCodeService.ensureAccessToken({
        upstreamId: record.id,
        fetcher,
      });
      const apiModels = await fetchClaudeCodeModelsList(access.entry.token, fetcher);
      return buildClaudeCodeCatalog(apiModels, enabledFlags);
    },
  };

  return {
    upstreamId: record.id,
    kind: 'claude-code',
    name: record.name,
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    instance,
  };
};
