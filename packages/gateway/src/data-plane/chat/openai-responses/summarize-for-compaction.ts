import { OPENAI_RESPONSES_STREAMED_USAGE, type Fields } from './facts.ts';
import type { ChatServices } from '../services.ts';
import { buildCompactionEnvelope, cacheSharingSummarizationTurnFor, EMPTY_SUMMARY_MESSAGE, summarizationTurnFor, summaryTextFrom, sumResponseUsage } from './compact-shim.ts';
import { syntheticEventsFromResult } from './items/output.ts';
import { isFailure } from '../../pipeline/facts.ts';
import type { StreamOutcome } from '../../pipeline/serve.ts';
import { defineStage, move, type Use, type Deferred, type Owned } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, createRandomOpenAIResponsesItemId, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

/** How the chain that composed the stage below says a turn reaching it asked for a compaction.
 *  It is the whole gate, so each chain states its own: what asks for a compaction differs by
 *  operation, and no action travels in the record for the stage to read instead. */
export type CompactionAsk = (
  facts: Fields<'request.chat.openaiResponses' | 'route.attempt'>,
  use: Use<ChatServices>,
) => boolean;

/**
 * Answers a turn that asked for a compaction with one, over an upstream that has no
 * compaction wire.
 *
 * It first asks for the summary in the cache-sharing shape, which keeps the turn's prefix so the
 * upstream can reuse its prompt cache. An answer with no text — a tool call, or nothing — is not
 * a summary, so it asks once more in the compatibility shape: the compactor's prompt at the head
 * of the history and a terminal nudge. Each ask is its own upstream call and is billed as one;
 * the envelope reports their combined usage. Below it is the ordinary generate fork, which is
 * what makes every wire generation can take a wire a compaction can be simulated over.
 *
 * What the simulation cannot reproduce is stated where it happens, at `summarizationTurnFor`.
 */
export const summarizeForCompaction = (asked: CompactionAsk) => defineStage<
  Fields<'request.chat.openaiResponses' | 'route.attempt'>,
  Fields<'request.chat.openaiResponses'>,
  Fields<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage' | 'response.usage.billable' | 'response.http.body'>,
  Fields<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage' | 'response.usage.billable' | 'response.http.body'>,
  ChatServices
>({
  name: 'summarizeForCompaction',
  through: {
    request: {
      needs: ['request.chat.openaiResponses', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiResponses'],
    },
    response: {
      needs: ['response.chat.openaiResponses', OPENAI_RESPONSES_STREAMED_USAGE, 'response.usage.billable'],
      consumes: ['response.http.body'],
      provides: ['response.chat.openaiResponses', OPENAI_RESPONSES_STREAMED_USAGE, 'response.usage.billable', 'response.http.body'],
    },
  },
  execute: async (facts, next, use) => {
    if (!asked(facts, use)) return await next(facts);
    const payload = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
    type Back = Awaited<ReturnType<typeof next>>;

    const billableOf = async (back: Back) => {
      const reading = back[OPENAI_RESPONSES_STREAMED_USAGE] as Deferred<StreamOutcome> | null;
      return reading === null ? back['response.usage.billable'] : (await reading).billable;
    };
    /** One ask, read to its summary. An upstream that refused is handed on as it came: the
     *  client learns the compaction failed rather than being given a silent empty envelope.
     *  One that answered with a single envelope compacted on its own, and an envelope is
     *  already the answer — there are no frames to fold and nothing this layer could add. */
    const ask = async (turn: CanonicalOpenAIResponsesPayload) => {
      const back = await next({ ...facts, 'request.chat.openaiResponses': move(turn) });
      const { 'response.http.body': body, ...rest } = back;
      const consumed = { ...rest, 'response.http.body': null };
      const answer = back['response.chat.openaiResponses'];
      if (isFailure(answer) || answer.kind !== 'stream') {
        if (body !== null) await (body as Owned)[Symbol.asyncDispose]();
        return { kind: 'answered' as const, back: consumed };
      }
      const collected: OpenAIResponsesResultEx = await collectOpenAIResponsesProtocolEventsToResult(answer.frames as AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>);
      if (body !== null) await (body as Owned)[Symbol.asyncDispose]();
      return { kind: 'collected' as const, back: consumed, collected, text: summaryTextFrom(collected.output) };
    };
    const envelope = (text: string, upstream: OpenAIResponsesResultEx) =>
      move({ kind: 'stream' as const, frames: syntheticEventsFromResult(buildCompactionEnvelope(createRandomOpenAIResponsesItemId('compaction'), text, upstream)) });

    const shared = await ask(cacheSharingSummarizationTurnFor(payload));
    if (shared.kind === 'answered') return shared.back;
    if (shared.text.trim().length > 0) return { ...shared.back, 'response.chat.openaiResponses': envelope(shared.text, shared.collected) };

    await use.log.warn('the cache-sharing summarization returned no assistant text; retrying with the system-prompt summarizer');
    const sharedBillable = await billableOf(shared.back);
    const fallback = await ask(summarizationTurnFor(payload));
    if (fallback.kind === 'answered') {
      return { ...fallback.back, 'response.usage.billable': move([...sharedBillable, ...await billableOf(fallback.back)]), [OPENAI_RESPONSES_STREAMED_USAGE]: null };
    }
    const billable = move([...sharedBillable, ...await billableOf(fallback.back)]);
    if (fallback.text.length === 0) {
      // A summarization that closed no text produced no summary, and the blob is the whole of
      // what the next turn inherits — so this is a candidate that did not do the job rather
      // than a fault that ends the request, and the fork can try another.
      return { ...fallback.back, 'response.chat.openaiResponses': move({ status: 502, message: EMPTY_SUMMARY_MESSAGE }), 'response.usage.billable': billable, [OPENAI_RESPONSES_STREAMED_USAGE]: null };
    }
    const combined = { ...fallback.collected, usage: sumResponseUsage(shared.collected.usage, fallback.collected.usage) };
    return { ...fallback.back, 'response.chat.openaiResponses': envelope(fallback.text, combined), 'response.usage.billable': billable, [OPENAI_RESPONSES_STREAMED_USAGE]: null };
  },
});
