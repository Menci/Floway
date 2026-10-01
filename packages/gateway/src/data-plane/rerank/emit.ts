import type { Fields } from './facts.ts';
import { isFailure, mintedErrorEnvelope, renderFailure } from '../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { renderErrorEnvelope } from '@floway-dev/protocols/common';
import { renderRerankResponse } from '@floway-dev/protocols/rerank';

/**
 * The outermost edge. Renders the canonical answer into the protocol the client spoke —
 * which is why `ingress.rerank.sourceProtocol` is an ingress fact and not a request one:
 * it survives the switch to whatever protocol the upstream turned out to speak.
 */
export const emitRerank = defineStage<
  Fields<'ingress.rerank.sourceProtocol' | 'request.rerank.canonical'>,
  Fields<'ingress.rerank.sourceProtocol' | 'request.rerank.canonical'>,
  Fields<'ingress.rerank.sourceProtocol' | 'request.rerank.canonical' | 'response.rerank.canonical' | 'response.rerank.targetProtocol' | 'response.http.status' | 'response.http.headers'>,
  Fields<'response.rerank.rendered' | 'response.http.status' | 'response.http.headers'>
>({
  name: 'emitRerank',
  through: {
    request: {
      needs: ['ingress.rerank.sourceProtocol', 'request.rerank.canonical'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.rerank.canonical', 'response.http.headers', 'response.http.status'],
      consumes: ['response.rerank.canonical', 'response.rerank.targetProtocol', 'response.http.headers'],
      provides: ['response.rerank.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.rerank.canonical': answer, 'response.rerank.targetProtocol': target, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);
    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.rerank.rendered': move(renderFailure(answer, mintedErrorEnvelope).body),
        // The upstream's own status, or the gateway's own when it refused before dialling.
        // A client is not owed the upstream's exact bytes; it is owed the truth about what
        // happened, and a 429 arriving as a 200 is not that.
        'response.http.status': answer.status,
      };
    }
    // Translating can fail on an answer that parsed: a result may index a document the
    // request never sent. The upstream answered and the gateway cannot put that answer in the
    // protocol the client speaks, which is the gateway failing to serve rather than anything
    // the client can fix — so it is 502, and a value like every other failure here.
    let rendered: Record<string, unknown>;
    try {
      rendered = renderRerankResponse(
        back['ingress.rerank.sourceProtocol'],
        target,
        answer,
        back['request.rerank.canonical'],
      );
    } catch (error) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.rerank.rendered': move(renderErrorEnvelope(error instanceof Error ? error.message : String(error))),
        'response.http.status': 502,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.http.status': back['response.http.status'],
      'response.rerank.rendered': move(rendered),
    };
  },
});
