import type { Fields } from './facts.ts';
import { isFailure, renderFailure, mintedErrorEnvelope } from '../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { renderErrorEnvelope, type JsonObject } from '@floway-dev/protocols/common';
import { parseDecisionResponse, renderDecisionResponse } from '@floway-dev/protocols/decision';

/**
 * The outermost edge. A client on the upstream's own dialect is answered with the upstream's
 * own document, vendor extensions and number tokens included; a client on the other dialect is
 * answered with the canonical reading of it, rendered into its own.
 */
export const emitDecision = defineStage<
  Fields<'ingress.decision.sourceProtocol'>,
  Fields<'ingress.decision.sourceProtocol'>,
  Fields<'ingress.decision.sourceProtocol' | 'response.decision.answer' | 'response.decision.targetProtocol' | 'response.http.status' | 'response.http.headers'>,
  Fields<'response.decision.rendered' | 'response.http.status' | 'response.http.headers'>
>({
  name: 'emitDecision',
  through: {
    request: { needs: ['ingress.decision.sourceProtocol'], consumes: [], provides: [] },
    response: {
      needs: ['response.decision.answer', 'response.http.headers', 'response.http.status'],
      consumes: ['response.decision.answer', 'response.decision.targetProtocol', 'response.http.headers'],
      provides: ['response.decision.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.decision.answer': answer, 'response.decision.targetProtocol': target, 'response.http.headers': headers, ...rest } = back;
    // A filter that removed nothing hands the same array on, so the record shows no change
    // where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);
    if (isFailure(answer)) {
      const failure = renderFailure(answer, mintedErrorEnvelope);
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.decision.rendered': move(failure.body),
        'response.http.status': failure.status,
      };
    }
    const source = back['ingress.decision.sourceProtocol'];
    if (source === target) {
      return { ...rest, 'response.http.headers': forClient, 'response.http.status': back['response.http.status'], 'response.decision.rendered': answer.body };
    }
    // The upstream answered and the gateway cannot put that answer in the client's dialect —
    // a refusal one dialect can express and the other cannot, or an answer missing the detail
    // both contracts require. That is the gateway failing to serve, so it is 502.
    let rendered: JsonObject;
    try {
      rendered = renderDecisionResponse(source, parseDecisionResponse(target, answer.body));
    } catch (error) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.decision.rendered': move(renderErrorEnvelope(error instanceof Error ? error.message : String(error))),
        'response.http.status': 502,
      };
    }
    return { ...rest, 'response.http.headers': forClient, 'response.http.status': back['response.http.status'], 'response.decision.rendered': move(rendered) };
  },
});
