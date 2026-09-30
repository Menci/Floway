import type { Fields } from './facts.ts';
import { syntheticEventsFromCompaction } from './items/output.ts';
import { bodyForAttempt } from '../../pipeline/attempt-body.ts';
import type { BillableEntity } from '../../pipeline/facts.ts';
import { upstreamPerformanceContext, telemetryModelIdentity } from '../../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import type { ChatServices } from '../services.ts';
import { applyRulesToUpstreamOpenAIResponses } from '../shared/alias-rules.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { providerModelOf } from '@floway-dev/provider';

/**
 * The wire. It dials OpenAI Responses and provides the answer at whichever family's response key the
 * chain above it reads — which is what makes it interchangeable with a translated chain: both
 * hand up `response.chat.openaiResponses`, and the stage above cannot tell which ran.
 */
export const callOpenAIResponsesUpstream = defineStage<
  Fields<'request.chat.openaiResponses' | 'route.attempt' | 'ingress.http.headers'>,
  Fields<'response.chat.openaiResponses' | 'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'callOpenAIResponsesUpstream',
  return: {
    provides: [
      'response.chat.openaiResponses',
      'response.usage.billable',
      'response.http.headers',
    ],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'chat');

    // What the record holds by now: the payload affinity materialized for this candidate, as
    // every stage between the fork and here has rewritten it — or, on a translated wire, what
    // the handoff put here. Client-carried state — an encrypted reasoning blob, a compaction
    // the upstream issued — was rewritten for the upstream that will see it, which is the
    // whole reason a turn can be pinned at all.
    //
    // The key holds what a client may send, whose `input` is a string or a list; this chain
    // runs on the canonical form the entry normalized it to, which is the one a wire takes.
    const asked = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
    const body = bodyForAttempt(asked, candidate, applyRulesToUpstreamOpenAIResponses);

    let result;
    try {
      result = await candidate.provider.instance.callOpenAIResponses(
        providerModelOf(candidate),
        body,
        'generate',
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
        'response.chat.openaiResponses': { status: 502, message: error instanceof Error ? error.message : String(error) },
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
        'response.chat.openaiResponses': {
          status: result.response.status,
          message: text,
          ...(parsed === undefined ? {} : { body: parsed }),
        },
        'response.usage.billable': called,
        'response.http.headers': [...result.response.headers],
      });
    }

    // This candidate answered, so it is the one a follow-up turn carrying our own state must
    // come back to.
    use.selectAffinity(candidate);

    if (result.action === 'compact') {
      return move({
        ...facts,
        'response.chat.openaiResponses': { kind: 'stream' as const, frames: syntheticEventsFromCompaction(result.result) },
        'response.usage.billable': called,
        'response.http.headers': [],
      });
    }

    return move({
      ...facts,
      'response.chat.openaiResponses': { kind: 'stream' as const, frames: result.events },
      'response.usage.billable': called,
      'response.http.headers': [...(result.headers ?? new Headers())],
    });
  },
});
