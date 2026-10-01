import { sleep } from '../../../../../shared/sleep.ts';
import type { Fields } from '../../../../openai-images/facts.ts';
import type { BillableEntity } from '../../../../pipeline/facts.ts';
import type { StreamOutcome } from '../../../../pipeline/serve.ts';
import type { GatewayServices } from '../../../../pipeline/services.ts';
import { defineStage, move, defer, type Deferred } from '@floway-dev/pipeline';

// 60s cap matches the per-minute refill window of Azure TPM/RPM and
// openai.com tier image quotas — same clamp openai-python applies in
// [`_calculate_retry_timeout`](https://github.com/openai/openai-python/blob/d76d8c11c1da9f97aa8a0aaee8ccd44d2bc8f5e7/src/openai/_base_client.py#L789).
const RETRY_CAP_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 2;

// Header priority matches openai-python's `_parse_retry_after_header` with
// Azure's `x-ms-retry-after-ms` alias added. Treats <= 0 as "no hint" so the
// gpt-image-1 `retry-after: 0.0` quirk falls back to backoff instead of
// pretending the quota is free.
export const parseRetryAfterMs = (headers: Headers): number | null => {
  for (const name of ['retry-after-ms', 'x-ms-retry-after-ms']) {
    const raw = headers.get(name);
    if (raw === null) continue;
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const ra = headers.get('retry-after');
  if (ra !== null) {
    const seconds = Number(ra);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const httpDateMs = Date.parse(ra);
    if (!Number.isNaN(httpDateMs)) {
      const delta = httpDateMs - Date.now();
      if (delta > 0) return delta;
    }
  }
  return null;
};

export const retryRateLimitedImages = defineStage<
  Fields<'request.openaiImages.canonical' | 'route.attempt' | 'serve.usage.prior'>,
  Fields<'request.openaiImages.canonical' | 'route.attempt' | 'serve.usage.prior'>,
  Fields<'response.http.status' | 'response.http.headers' | 'response.http.body' | 'response.usage.billable' | 'response.openaiImages.streamedUsage'>,
  Fields<'response.http.status' | 'response.http.headers' | 'response.http.body' | 'response.usage.billable' | 'response.openaiImages.streamedUsage'>,
  GatewayServices
>({
  name: 'retryRateLimitedImages',
  through: {
    request: { needs: ['request.openaiImages.canonical', 'route.attempt', 'serve.usage.prior'], consumes: [], provides: ['serve.usage.prior'] },
    response: {
      needs: ['response.http.status', 'response.http.headers', 'response.http.body', 'response.usage.billable', 'response.openaiImages.streamedUsage'],
      consumes: ['response.http.body'],
      provides: ['response.http.body', 'response.usage.billable', 'response.openaiImages.streamedUsage'],
    },
  },
  execute: async (facts, next, use) => {
    const prior: BillableEntity[] = [];
    for (let retry = 0; ; retry++) {
      const back = await next({ ...facts, 'serve.usage.prior': move([...facts['serve.usage.prior'], ...prior]) });
      if (back['response.http.status'] !== 429 || retry >= MAX_RATE_LIMIT_RETRIES) {
        if (prior.length === 0) return { ...back, 'serve.usage.prior': facts['serve.usage.prior'] };
        const pending = back['response.openaiImages.streamedUsage'] as Deferred<StreamOutcome> | null;
        const calls = move([...prior]);
        return {
          ...back,
          'serve.usage.prior': facts['serve.usage.prior'],
          'response.usage.billable': move([...calls, ...back['response.usage.billable']]),
          'response.openaiImages.streamedUsage': pending === null ? null
            : move(defer(pending.then(outcome => ({ ...outcome, billable: move([...calls, ...outcome.billable]) })))),
        };
      }
      prior.push(...back['response.usage.billable']);
      const base = 1000 * 2 ** retry;
      const backoffMs = base + Math.random() * base * 0.25;
      const headers = new Headers(back['response.http.headers'].map(([name, value]): [string, string] => [name, value]));
      await sleep(Math.min(parseRetryAfterMs(headers) ?? backoffMs, RETRY_CAP_MS), use.gateway.abortSignal);
      use.gateway.attempt.timing.upstreamCallStartedAt = null;
      use.gateway.attempt.timing.firstOutputTokenAt = null;
    }
  },
});
