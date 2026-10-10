import type { UpstreamRecord } from './model.ts';
import type { Fetcher } from './options.ts';
import { getProviderRepo } from './repo.ts';

export interface ScheduledTaskClaim {
  upstreamId: string;
  task: string;
  token: string;
  now: number;
  nextAttemptAt: number;
}

export interface ProviderScheduledTasksRepo {
  tryClaim(claim: ScheduledTaskClaim): Promise<number | null>;
  finish(claim: ScheduledTaskClaim, outcome: { nextAttemptAt: number; failureCount: number; error: string | null }): Promise<void>;
}

export interface ProviderScheduledOptions {
  fetcher: (record: UpstreamRecord) => Promise<Fetcher | null>;
  tasks: ProviderScheduledTasksRepo;
}

// Five minutes is our polling policy, shared with failure backoff. Providers
// can avoid a probe when traffic has already produced a newer observation.
export const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_RETRY_INTERVAL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export const runScheduledUsageRefresh = async (
  record: UpstreamRecord,
  options: ProviderScheduledOptions,
  lastObservedAt: number | null,
  refresh: (record: UpstreamRecord, fetcher: Fetcher) => Promise<unknown>,
): Promise<void> => {
  const now = Date.now();
  if (!record.enabled || !record.usageRefreshEnabled
    || (lastObservedAt !== null && now - lastObservedAt < USAGE_REFRESH_INTERVAL_MS)) return;
  const claim: ScheduledTaskClaim = {
    upstreamId: record.id,
    task: 'usage-refresh',
    token: crypto.randomUUID(),
    now,
    nextAttemptAt: now + USAGE_REFRESH_INTERVAL_MS,
  };
  const failureCount = await options.tasks.tryClaim(claim);
  if (failureCount === null) return;
  let retryAt = claim.nextAttemptAt;
  try {
    const fresh = await getProviderRepo().upstreams.getById(record.id);
    if (fresh === null || !fresh.enabled || !fresh.usageRefreshEnabled || fresh.kind !== record.kind) {
      await options.tasks.finish(claim, { nextAttemptAt: now, failureCount: 0, error: null });
      return;
    }
    const fetcher = await options.fetcher(fresh);
    if (fetcher === null) {
      await options.tasks.finish(claim, { nextAttemptAt: now, failureCount: 0, error: null });
      return;
    }
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const timedFetcher: Fetcher = async (url, init) => {
      const response = await fetcher(url, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      });
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter !== null) {
        const seconds = Number(retryAfter);
        const until = retryAfter.trim() !== '' && Number.isFinite(seconds)
          ? Date.now() + seconds * 1000
          : Date.parse(retryAfter);
        if (Number.isFinite(until)) retryAt = Math.max(retryAt, until);
      }
      const pollInterval = Number(response.headers.get('x-poll-interval'));
      if (Number.isFinite(pollInterval) && pollInterval > 0) retryAt = Math.max(retryAt, Date.now() + pollInterval * 1000);
      if (response.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(response.headers.get('x-ratelimit-reset'));
        if (Number.isFinite(reset)) retryAt = Math.max(retryAt, reset * 1000);
      }
      return response;
    };
    await refresh(fresh, timedFetcher);
  } catch (error) {
    const nextFailureCount = failureCount + 1;
    retryAt = Math.max(retryAt, Date.now() + Math.min(MAX_RETRY_INTERVAL_MS, USAGE_REFRESH_INTERVAL_MS * 2 ** Math.min(nextFailureCount, 4)));
    try {
      await options.tasks.finish(claim, {
        nextAttemptAt: retryAt,
        failureCount: nextFailureCount,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (persistenceError) {
      throw new AggregateError([error, persistenceError], 'Usage refresh and outcome persistence failed');
    }
    throw error;
  }
  await options.tasks.finish(claim, { nextAttemptAt: Math.max(retryAt, Date.now() + USAGE_REFRESH_INTERVAL_MS), failureCount: 0, error: null });
};
