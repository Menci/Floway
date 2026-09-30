import type { Fields } from './facts.ts';
import { isFailure } from '../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { renderErrorEnvelope } from '@floway-dev/protocols/common';
import { renderOpenAIEmbeddingsResponse } from '@floway-dev/protocols/openai-embeddings';

/**
 * The outermost edge. Writes the vectors in the encoding the client asked for — which is
 * why the encoding is an ingress fact and not a request one: it has to survive an upstream
 * that answered in the other one. A client on an official OpenAI SDK asked for `base64`
 * without its caller choosing to, and will decode as base64 whatever it is handed.
 */
export const emitOpenAIEmbeddings = defineStage<
  Fields<'ingress.openaiEmbeddings.encodingFormat'>,
  Fields<'ingress.openaiEmbeddings.encodingFormat'>,
  Fields<'ingress.openaiEmbeddings.encodingFormat' | 'response.openaiEmbeddings.canonical' | 'response.http.headers'>,
  Fields<'response.openaiEmbeddings.rendered' | 'response.http.status' | 'response.http.headers'>
>({
  name: 'emitOpenAIEmbeddings',
  through: {
    request: {
      needs: ['ingress.openaiEmbeddings.encodingFormat'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.openaiEmbeddings.canonical', 'response.http.headers'],
      consumes: ['response.openaiEmbeddings.canonical', 'response.http.headers'],
      provides: ['response.openaiEmbeddings.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.openaiEmbeddings.canonical': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);
    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.openaiEmbeddings.rendered': move(renderErrorEnvelope(answer.message, answer.body)),
        // The upstream's own status, or the gateway's own when it refused before dialling.
        // A client is not owed the upstream's exact bytes; it is owed the truth about what
        // happened, and a 429 arriving as a 200 is not that.
        'response.http.status': answer.status,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.http.status': 200,
      'response.openaiEmbeddings.rendered': move(renderOpenAIEmbeddingsResponse(back['ingress.openaiEmbeddings.encodingFormat'], answer)),
    };
  },
});
