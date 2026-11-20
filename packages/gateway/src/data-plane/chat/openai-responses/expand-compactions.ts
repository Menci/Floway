import type { Fields } from './facts.ts';
import type { ChatServices } from '../services.ts';
import { expandShimCompactionItems } from './compact-shim.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

/**
 * Expands a compaction this gateway wrote back into the history it stood for.
 *
 * The shim's envelope carries the items it summarized, so a turn that echoes one back is sent
 * that history rather than an opaque blob the upstream has no key for. A blob this gateway
 * did not write — a native upstream's own encrypted compaction — fails the decode and rides
 * through untouched, which is what lets an operator turn the flag off for an upstream that
 * compacts natively.
 *
 */
export const expandShimCompactions = defineStage<
  Fields<'request.chat.openaiResponses'>,
  Fields<'request.chat.openaiResponses'>,
  Record<string, never>,
  Record<string, never>,
  ChatServices
>({
  name: 'expandShimCompactions',
  through: {
    request: {
      needs: ['request.chat.openaiResponses'],
      consumes: [],
      provides: ['request.chat.openaiResponses'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const payload = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
    const expanded = expandShimCompactionItems(payload);
    // A turn carrying none of ours hands the same payload on, so the record shows no change
    // where none happened.
    if (expanded === payload) return await next(facts);
    return await next({ ...facts, 'request.chat.openaiResponses': move(expanded) });
  },
});
