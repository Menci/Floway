import type { Fields } from './facts.ts';
import { bodyForAttempt } from '../../pipeline/attempt-body.ts';
import type { BillableEntity } from '../../pipeline/facts.ts';
import { upstreamPerformanceContext, telemetryModelIdentity } from '../../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import type { ChatServices } from '../services.ts';
import { applyRulesToUpstreamOpenAIChatCompletions } from '../shared/alias-rules.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { providerModelOf } from '@floway-dev/provider';

/**
 * The wire. It dials OpenAI Chat Completions and provides the answer at whichever family's response
 * key the chain above it reads — which is what makes it interchangeable with a translated
 * chain: both hand up `response.chat.openaiChatCompletions`, and the stage above cannot tell which
 * ran.
 *
 * What it hands up is the upstream's own frames, unread. The reading is taken at the top of the
 * wire, above every rule that rewrites them, so nothing here has the means to produce a figure
 * the client will not be shown.
 */
export const callOpenAIChatCompletionsUpstream = defineStage<
  Fields<'request.chat.openaiChatCompletions' | 'route.attempt' | 'ingress.http.headers'>,
  Fields<'response.chat.openaiChatCompletions' | 'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'callOpenAIChatCompletionsUpstream',
  return: {
    provides: [
      'response.chat.openaiChatCompletions',
      'response.usage.billable',
      'response.http.headers',
    ],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'chat');

    // What the record holds by now: the payload affinity materialized for this candidate,
    // as every stage between the fork and here has rewritten it — or, on a translated wire,
    // what the handoff put here.
    const body = bodyForAttempt(facts['request.chat.openaiChatCompletions'], candidate, applyRulesToUpstreamOpenAIChatCompletions);

    let result;
    try {
      result = await candidate.provider.instance.callOpenAIChatCompletions(
        providerModelOf(candidate),
        body,
        use.gateway.abortSignal,
        // The client's own headers reach the upstream from the record, not from a live
        // request object: what a provider is allowed to forward is filtered per provider,
        // and the dump shows what was there to filter.
        buildUpstreamCallOptions(candidate, use.gateway, new Headers(facts['ingress.http.headers'].map(([name, value]): [string, string] => [name, value]))),
      );
    } catch (error) {
      use.log.warn('dial failed', { upstream: facts['route.attempt'].upstreamId, error: String(error) });
      // A dial that never completed reached no upstream, so nothing was billed and there are
      // no headers to carry. What it leaves behind is the performance row settlement writes.
      return move({
        ...facts,
        'response.chat.openaiChatCompletions': { status: 502, message: error instanceof Error ? error.message : String(error) },
        'response.usage.billable': [],
        'response.http.headers': [],
      });
    }

    const identity = telemetryModelIdentity(candidate, result.modelKey);
    // An upstream that was called and reported nothing, which is a different statement from
    // reporting zero.
    const called: readonly BillableEntity[] = [{ identity, quantities: {} }];

    if (!result.ok) {
      const text = await result.response.text();
      use.log.warn('upstream refused', { status: result.response.status });
      let parsed: unknown;
      try { parsed = JSON.parse(text) as unknown; } catch { parsed = undefined; }
      return move({
        ...facts,
        'response.chat.openaiChatCompletions': {
          status: result.response.status,
          message: text,
          ...(parsed === undefined ? {} : { body: parsed }),
        },
        'response.usage.billable': called,
        'response.http.headers': [...result.response.headers],
      });
    }

    // This candidate answered, so it is the one a follow-up turn carrying our own state
    // must come back to.
    use.selectAffinity(candidate);
    return move({
      ...facts,
      'response.chat.openaiChatCompletions': { kind: 'stream' as const, frames: result.events },
      'response.usage.billable': called,
      'response.http.headers': [...(result.headers ?? new Headers())],
    });
  },
});
