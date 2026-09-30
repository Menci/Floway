import type { Fields } from './facts.ts';
import { renderAlphaSearchResponse } from './protocol.ts';
import { isJsonObject } from '../../shared/json-helpers.ts';
import { isFailure } from '../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { defineStage, move } from '@floway-dev/pipeline';

/**
 * The outermost edge. Renders the answer into Codex's protocol and says what status the
 * client is owed — the one thing a failure value carries that a rendered body cannot.
 *
 * It declares needing `response.usage.billable` without reading it, which is this family's
 * statement that every path accounts for usage: assembly then rejects an ending, or a
 * short-circuit, that does not provide it.
 */
export const emitAlphaSearch = defineStage<
  Fields<never>,
  Fields<never>,
  Fields<'response.search.alphaSearch' | 'response.usage.billable' | 'response.http.headers'>,
  Fields<'response.search.rendered' | 'response.http.status' | 'response.http.headers'>
>({
  name: 'emitAlphaSearch',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.search.alphaSearch', 'response.usage.billable', 'response.http.headers'],
      consumes: ['response.search.alphaSearch', 'response.http.headers'],
      provides: ['response.search.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.search.alphaSearch': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);
    if (isFailure(answer)) {
      // An upstream error body is JSON like any other: it was parsed below and is serialized
      // again here. A body that was not an object is one this protocol cannot carry, so what
      // goes out instead is the gateway's own envelope.
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.search.rendered': move(isJsonObject(answer.body)
          ? answer.body
          : { error: { message: answer.message, type: 'api_error' } }),
        'response.http.status': answer.status,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.search.rendered': move(renderAlphaSearchResponse(answer)),
      'response.http.status': 200,
    };
  },
});
