import type { Counted, Fields } from './facts.ts';
import { isFailure, renderFailure, mintedAs } from '../../../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../../../shared/upstream-response.ts';
import type { ChatServices } from '../../services.ts';
import { renderAnthropicMessagesError } from '../errors.ts';
import { defineStage, move } from '@floway-dev/pipeline';

/**
 * The outermost edge. A measurement is one object, so there is nothing to fold and nothing
 * to stream: what this decides is only whether the client is shown the upstream's counts or
 * the refusal that stands in for them.
 */
export const emitAnthropicMessagesTokenCount = defineStage<
  Record<string, never>,
  Record<string, never>,
  Counted<'response.chat.anthropicMessages'> & Fields<'response.http.headers' | 'response.http.status'>,
  Fields<'response.chat.anthropicMessages.rendered' | 'response.http.status' | 'response.http.headers'>,
  ChatServices
>({
  name: 'emitAnthropicMessagesTokenCount',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.anthropicMessages', 'response.http.headers', 'response.http.status'],
      consumes: ['response.chat.anthropicMessages', 'response.http.headers'],
      provides: ['response.chat.anthropicMessages.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.chat.anthropicMessages': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      const failure = renderFailure(answer, mintedAs(({ status, message }) => renderAnthropicMessagesError(status, message)));
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.anthropicMessages.rendered': move(failure.body),
        'response.http.status': failure.status,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.chat.anthropicMessages.rendered': move(answer.body as Record<string, unknown>),
      'response.http.status': back['response.http.status'],
    };
  },
});
