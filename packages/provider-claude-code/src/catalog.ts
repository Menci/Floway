import { assertClaudeCodeUpstreamRecord } from './config.ts';
import { CLAUDE_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { buildClaudeCodeCatalog, fetchClaudeCodeModelsList } from './models.ts';
import type { ClaudeCodeService } from './service.ts';
import { resolveEffectiveFlags, type Fetcher, type UpstreamRecord } from '@floway-dev/provider';

export const getClaudeCodeProvidedModels = async (record: UpstreamRecord, fetcher: Fetcher, claudeCode: ClaudeCodeService) => {
  assertClaudeCodeUpstreamRecord(record);
  const { entry } = await claudeCode.ensureAccessToken({ upstreamId: record.id, fetcher });
  const apiModels = await fetchClaudeCodeModelsList(entry.token, fetcher);
  return buildClaudeCodeCatalog(apiModels, resolveEffectiveFlags([CLAUDE_CODE_DEFAULT_FLAGS, record.flagOverrides]));
};
