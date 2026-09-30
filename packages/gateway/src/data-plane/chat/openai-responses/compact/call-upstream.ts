import type { Fields } from '../facts.ts';
import type { Compacted } from './facts.ts';
import { bodyForAttempt } from '../../../pipeline/attempt-body.ts';
import { upstreamPerformanceContext, telemetryModelIdentity } from '../../../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../../../shared/upstream-call-options.ts';
import type { ChatServices } from '../../services.ts';
import { applyRulesToUpstreamOpenAIResponses } from '../../shared/alias-rules.ts';
import { OPENAI_RESPONSES_STREAMED_USAGE } from '../facts.ts';
import { syntheticEventsFromCompaction } from '../items/output.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { providerModelOf } from '@floway-dev/provider';

/**
 * The compaction wire. It asks the upstream's own `/responses` endpoint to compact, and hands
 * the envelope up as the events it expands into — the same currency a generate wire hands up,
 * which is what lets the stateful half above read either without knowing which ran.
 */
export const callOpenAIResponsesCompactUpstream = defineStage<
  Fields<'request.chat.openaiResponses' | 'route.attempt' | 'ingress.http.headers'>,
  Compacted<'response.chat.openaiResponses'> & Fields<'response.chat.openaiResponses.streamedUsage' | 'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'callOpenAIResponsesCompactUpstream',
  return: {
    provides: [
      'response.chat.openaiResponses',
      OPENAI_RESPONSES_STREAMED_USAGE,
      'response.usage.billable',
      'response.http.headers',
    ],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'chat');

    const asked = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
    // Neither field belongs on this endpoint: `store` is a gateway-only snapshot hint the
    // compaction endpoint rejects, and `stream` describes how an answer would be delivered
    // where there is one body and no stream.
    const { stream: _stream, store: _store, ...body } = bodyForAttempt(asked, candidate, applyRulesToUpstreamOpenAIResponses);

    let result;
    try {
      result = await candidate.provider.instance.callOpenAIResponses(
        providerModelOf(candidate),
        body,
        'compact',
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
        [OPENAI_RESPONSES_STREAMED_USAGE]: null,
        'response.usage.billable': [],
        'response.http.headers': [],
      });
    }

    const identity = telemetryModelIdentity(candidate, result.modelKey);
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
        [OPENAI_RESPONSES_STREAMED_USAGE]: null,
        // An upstream that was called and reported nothing, which is a different statement
        // from reporting zero.
        'response.usage.billable': [{ identity, quantities: {} }],
        'response.http.headers': [...result.response.headers],
      });
    }
    if (result.action !== 'compact') {
      throw new Error(`callOpenAIResponsesCompactUpstream: ${facts['route.attempt'].upstreamId} answered a compaction dial with a ${result.action} turn`);
    }

    // This candidate answered, so it is the one a follow-up turn carrying our own state must
    // come back to.
    use.selectAffinity(candidate);

    const billable = [{ identity, quantities: {} }];
    return move({
      ...facts,
      'response.chat.openaiResponses': { kind: 'stream' as const, frames: syntheticEventsFromCompaction(result.result) },
      // The outer meter reads the synthetic frames after this wire's usage normalizers.
      [OPENAI_RESPONSES_STREAMED_USAGE]: null,
      'response.usage.billable': billable,
      'response.http.headers': [],
    });
  },
});
