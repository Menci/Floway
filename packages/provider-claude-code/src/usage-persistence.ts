import { logInfo, logWarn } from './log.ts';
import { parseClaudeCodeQuotaHeaders, type ClaudeCodeQuotaSnapshot } from './quota.ts';
import { readClaudeCodeUpstreamState, replaceSoleAccount, type ClaudeCodeAccountCredential } from './state.ts';
import { claudeCodeQuotaMetrics } from './upstream-metrics.ts';
import { snapshotError, type Deferred, type ErrorSnapshot, type StageEnv } from '@floway-dev/pipeline';
import { getProviderRepo, recordUpstreamMetrics, type ProviderServices } from '@floway-dev/provider';

export type PersistenceResult = { readonly persisted: true } | { readonly persisted: false; readonly error: ErrorSnapshot };

const persistQuotaSnapshot = async (upstreamId: string, modelId: string, snapshot: ClaudeCodeQuotaSnapshot): Promise<void> => {
  // Stamped before the write: the mutator is replayed on a lost race and must
  // return the same document each time, and this records when the snapshot was
  // observed rather than which attempt landed it.
  const fetchedAt = Date.now();
  // The prior status comes from the state the mutator was handed: the write is
  // retried against whoever won the row, so only that view describes the
  // snapshot this write actually replaced.
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
  // Emit only on transition. Persisting every response would flood the log
  // with one event per request; the dashboard already reads the snapshot
  // verbatim. Operators care about the moment the upstream flipped from
  // `allowed` to `rejected` (or back), not the steady state.
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

export const observeQuota = (
  upstreamId: string,
  modelId: string,
  status: number,
  headers: Headers,
  env: StageEnv<ProviderServices>,
): Deferred<PersistenceResult> | undefined => {
  if ((status < 200 || status >= 300) && status !== 429) return undefined;
  const snapshot = parseClaudeCodeQuotaHeaders(headers);
  if (Object.keys(snapshot.raw).length === 0) return undefined;
  return env.defer<PersistenceResult>('claude-code.quota', persistQuotaSnapshot(upstreamId, modelId, snapshot).then(
    () => ({ persisted: true }),
    cause => {
      const fields = { upstream_id: upstreamId, error: String(cause) };
      logWarn('claude_code_quota_persist_failed', fields);
      env.log.warn('claude_code_quota_persist_failed', fields);
      return { persisted: false, error: snapshotError(cause) };
    },
  ));
};
