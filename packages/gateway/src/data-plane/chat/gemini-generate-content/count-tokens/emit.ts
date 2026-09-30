import type { Counted, Fields } from './facts.ts';
import { isFailure, renderFailure } from '../../../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../../../shared/upstream-response.ts';
import type { ChatServices } from '../../services.ts';
import { mintGeminiGenerateContentFailure } from '../errors.ts';
import { defineStage, move } from '@floway-dev/pipeline';

/**
 * The outermost edge. A measurement is one object, so there is nothing to fold and nothing to
 * stream: what this decides is only whether the client is shown the count or the refusal that
 * stands in for it.
 */
export const emitGeminiGenerateContentTokenCount = defineStage<
  Record<string, never>,
  Record<string, never>,
  Counted<'response.chat.geminiGenerateContent'> & Fields<'response.http.headers'>,
  Fields<'response.chat.geminiGenerateContent.rendered' | 'response.http.status' | 'response.http.headers'>,
  ChatServices
>({
  name: 'emitGeminiGenerateContentTokenCount',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.geminiGenerateContent', 'response.http.headers'],
      consumes: ['response.chat.geminiGenerateContent', 'response.http.headers'],
      provides: ['response.chat.geminiGenerateContent.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.chat.geminiGenerateContent': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      const failure = renderFailure(answer, mintGeminiGenerateContentFailure);
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.geminiGenerateContent.rendered': move(failure.body),
        'response.http.status': failure.status,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.chat.geminiGenerateContent.rendered': move(answer.body as Record<string, unknown>),
      'response.http.status': 200,
    };
  },
});
