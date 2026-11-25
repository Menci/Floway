import type { ClaudeCodeService } from './service.ts';
import { readClaudeCodeUpstreamState } from './state.ts';
import { fetchClaudeCodeUsageProbe } from './usage-probe.ts';
import { runScheduledUsageRefresh, type ProviderScheduledOptions, type UpstreamRecord } from '@floway-dev/provider';

export const runClaudeCodeScheduledTask = async (
  record: UpstreamRecord,
  options: ProviderScheduledOptions,
  claudeCode: ClaudeCodeService,
): Promise<void> => {
  const account = readClaudeCodeUpstreamState(record.state).accounts[0];
  // Setup tokens carry only user:inference; usage requires user:profile.
  // https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/service/account_usage_service.go#L477-L491
  if (account.state !== 'active' || account.tokenKind !== 'oauth') return;
  await runScheduledUsageRefresh(record, options, account.usageProbeSnapshot?.fetchedAt ?? null, async (fresh, fetcher) => {
    const access = await claudeCode.ensureAccessToken({ upstreamId: fresh.id, fetcher });
    const probe = await fetchClaudeCodeUsageProbe(access.entry.token, fetcher);
    await claudeCode.persistUsageProbe(fresh.id, probe);
  });
};
