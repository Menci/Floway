import { OPENAI_RESPONSES_STREAMED_USAGE, type Fields } from './facts.ts';
import type { ChatServices } from '../services.ts';
import { summarizationTurnFor, summaryTextFrom, EMPTY_SUMMARY_MESSAGE, buildCompactionEnvelope } from './compact-shim.ts';
import { syntheticEventsFromResult } from './items/output.ts';
import { isFailure } from '../../pipeline/facts.ts';
import type { StreamOutcome } from '../../pipeline/serve.ts';
import { defineStage, move, type Use, type Deferred } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, createRandomOpenAIResponsesItemId, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

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
 * It rewrites the turn on the way down — the compactor's prompt at the head of the history,
 * the trigger stripped, a terminal nudge appended, nothing persisted upstream — and folds the
 * generated summary into an envelope of this gateway's own on the way back. Below it is the
 * ordinary generate fork, which is what makes every wire generation can take a wire a
 * compaction can be simulated over.
 *
 * What the simulation cannot reproduce is stated where it happens, at `summarizationTurnFor`.
 */
export const summarizeForCompaction = (asked: CompactionAsk) => defineStage<
  Fields<'request.chat.openaiResponses' | 'route.attempt'>,
  Fields<'request.chat.openaiResponses'>,
  Fields<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage' | 'response.usage.billable'>,
  Fields<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage' | 'response.usage.billable'>,
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
      consumes: [],
      provides: ['response.chat.openaiResponses', OPENAI_RESPONSES_STREAMED_USAGE, 'response.usage.billable'],
    },
  },
  execute: async (facts, next, use) => {
    if (!asked(facts, use)) return await next(facts);
    const payload = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
    const back = await next({ ...facts, 'request.chat.openaiResponses': move(summarizationTurnFor(payload)) });

    const answer = back['response.chat.openaiResponses'];
    // An upstream that refused is handed on as it came: the client learns the compaction
    // failed rather than being given a silent empty envelope. One that answered with a single
    // envelope compacted on its own, and an envelope is already the answer — there are no
    // frames to fold and nothing this layer could add to it.
    if (isFailure(answer) || answer.kind !== 'stream') return back;

    const frames = answer.frames as AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>;
    const collected = await collectOpenAIResponsesProtocolEventsToResult(frames);

    const summaryText = summaryTextFrom(collected.output);
    if (summaryText.length === 0) {
      // A summarization that closed no text produced no summary, and the blob is the whole of
      // what the next turn inherits — so this is a candidate that did not do the job rather
      // than a fault that ends the request, and the fork can try another.
      const reading = back[OPENAI_RESPONSES_STREAMED_USAGE] as Deferred<StreamOutcome> | null;
      const billable = reading === null ? back['response.usage.billable'] : (await reading).billable;
      return { ...back, 'response.chat.openaiResponses': move({ status: 502, message: EMPTY_SUMMARY_MESSAGE }), 'response.usage.billable': move(billable), [OPENAI_RESPONSES_STREAMED_USAGE]: null };
    }

    const synthesized = buildCompactionEnvelope(createRandomOpenAIResponsesItemId('compaction'), summaryText, collected);
    return { ...back, 'response.chat.openaiResponses': move({ kind: 'stream' as const, frames: syntheticEventsFromResult(synthesized) }) };
  },
});
