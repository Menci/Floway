import type { Fields, Counted } from './facts.ts';
import { bodyForAttempt } from '../../../pipeline/attempt-body.ts';
import { buildUpstreamCallOptions } from '../../../shared/upstream-call-options.ts';
import type { ChatServices } from '../../services.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../../shared/alias-rules.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { parseAnthropicBetaHeader } from '@floway-dev/protocols/anthropic-messages';
import { providerModelOf } from '@floway-dev/provider';

/**
 * The ending. It asks the upstream what the turn would cost and hands the answer up as a
 * value — the one shape this operation ever produces, because a measurement is a body and
 * never a stream.
 */
export const callAnthropicMessagesCountTokensUpstream = defineStage<
  Fields<'request.chat.anthropicMessages' | 'route.attempt' | 'ingress.http.headers' | 'ingress.chat.sourceProtocol'>,
  Counted<'response.chat.anthropicMessages'> & Fields<'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'callAnthropicMessagesCountTokensUpstream',
  return: {
    provides: ['response.chat.anthropicMessages', 'response.usage.billable', 'response.http.headers'],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);

    // The payload affinity materialized for this candidate, as every stage between the fork
    // and here has rewritten it — built for the dial exactly as generation builds it, so what
    // is measured is what generation would be charged for.
    const body = bodyForAttempt(facts['request.chat.anthropicMessages'], candidate, applyRulesToUpstreamAnthropicMessages);

    // Anthropic's beta flags have a typed path of their own, so no header allowlist can admit
    // them, and they are the client's own only when the client spoke this protocol.
    const headers = new Headers(facts['ingress.http.headers'].map(([name, value]): [string, string] => [name, value]));
    const anthropicBeta = facts['ingress.chat.sourceProtocol'] === 'anthropicMessages'
      ? parseAnthropicBetaHeader(headers.get('anthropic-beta'))
      : [];
    headers.delete('anthropic-beta');

    // Nothing here is billed: measuring is not generating, and an upstream that answered
    // the question charged nothing for it.
    const nothingBilled = { 'response.usage.billable': [] as const };

    let response: Response;
    try {
      ({ response } = await candidate.provider.instance.callAnthropicMessagesCountTokens(
        providerModelOf(candidate),
        body,
        use.gateway.abortSignal,
        { ...buildUpstreamCallOptions(candidate, use.gateway, headers), anthropicBeta },
      ));
    } catch (error) {
      use.log.warn('dial failed', { upstream: facts['route.attempt'].upstreamId, error: String(error) });
      // A dial that never completed reached no upstream, so there are no headers to carry.
      return move({
        ...facts,
        ...nothingBilled,
        'response.chat.anthropicMessages': { status: 502, message: error instanceof Error ? error.message : String(error) },
        'response.http.headers': [],
      });
    }

    const text = await response.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { parsed = undefined; }

    if (!response.ok) {
      use.log.warn('upstream refused', { status: response.status });
      return move({
        ...facts,
        ...nothingBilled,
        'response.chat.anthropicMessages': {
          status: response.status,
          message: text,
          ...(parsed === undefined ? {} : { body: parsed }),
        },
        'response.http.headers': [...response.headers],
      });
    }

    return move({
      ...facts,
      ...nothingBilled,
      'response.chat.anthropicMessages': { kind: 'value' as const, body: parsed },
      'response.http.headers': [...response.headers],
    });
  },
});
