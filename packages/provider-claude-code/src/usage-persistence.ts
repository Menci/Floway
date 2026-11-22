import { logInfo } from './log.ts';
import { type ClaudeCodeQuotaSnapshot } from './quota.ts';
import { readClaudeCodeUpstreamState, replaceSoleAccount, type ClaudeCodeAccountCredential } from './state.ts';
import { claudeCodeQuotaMetrics } from './upstream-metrics.ts';
import { getProviderRepo, recordUpstreamMetrics } from '@floway-dev/provider';

export const persistQuotaSnapshot = async (
  upstreamId: string,
  modelId: string,
  snapshot: ClaudeCodeQuotaSnapshot,
): Promise<void> => {
  const fetchedAt = Date.now();
  let previousAccount!: ClaudeCodeAccountCredential;
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readClaudeCodeUpstreamState(current);
    previousAccount = state.accounts[0];
    return replaceSoleAccount(state, account => ({
      ...account,
      quotaSnapshot: { fetchedAt, modelId, data: snapshot },
    }));
  });
  await recordUpstreamMetrics(upstreamId, claudeCodeQuotaMetrics(snapshot), fetchedAt);
  const priorStatus = previousAccount.quotaSnapshot === null ? null : previousAccount.quotaSnapshot.data.status;
  if (priorStatus !== snapshot.status) {
    logInfo('claude_code_quota_state_transition', {
      upstream_id: upstreamId,
      account_uuid: previousAccount.accountUuid,
      from_status: priorStatus,
      to_status: snapshot.status,
      reset_at_iso: snapshot.reset,
      representative_claim: snapshot.representativeClaim,
      model: modelId,
    });
  }
};
