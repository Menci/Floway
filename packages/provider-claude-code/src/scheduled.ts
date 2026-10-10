import { ensureClaudeCodeAccessToken } from './access-token.ts';
import { readClaudeCodeUpstreamState } from './state.ts';
import { fetchClaudeCodeUsageProbe, persistClaudeCodeUsageProbe } from './usage-probe.ts';
import { getProviderRepo, runScheduledUsageRefresh, type ProviderScheduledOptions, type UpstreamRecord } from '@floway-dev/provider';

export const runClaudeCodeScheduledTask = async (record: UpstreamRecord, options: ProviderScheduledOptions): Promise<void> => {
  const account = readClaudeCodeUpstreamState(record.state).accounts[0];
  // Setup tokens carry only user:inference; usage requires user:profile.
  // https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/service/account_usage_service.go#L477-L491
  if (account.state !== 'active' || account.tokenKind !== 'oauth') return;
  await runScheduledUsageRefresh(record, options, account.usageProbeSnapshot?.fetchedAt ?? null, async (fresh, fetcher) => {
    const credential = readClaudeCodeUpstreamState(fresh.state).accounts[0];
    if (credential.state !== 'active' || credential.tokenKind !== 'oauth') return;
    const access = await ensureClaudeCodeAccessToken({ upstreamId: fresh.id, repo: getProviderRepo().upstreams, fetcher });
    const probe = await fetchClaudeCodeUsageProbe(access.entry.token, fetcher);
    await persistClaudeCodeUsageProbe(fresh.id, probe);
  });
};
