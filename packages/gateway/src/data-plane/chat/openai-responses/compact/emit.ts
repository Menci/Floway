import type { Compacted, Fields } from './facts.ts';
import { recordStream } from '../../../../dump/run-sink.ts';
import { isFailure, renderFailure, mintedErrorEnvelope } from '../../../pipeline/facts.ts';
import type { StreamOutcome } from '../../../pipeline/serve.ts';
import { isForwardableUpstreamHeader } from '../../../shared/upstream-response.ts';
import type { ChatServices } from '../../services.ts';
import { wrapOpenAIResponsesStatefulOutput, openaiResponsesCreatedAt } from '../client-output.ts';
import { completeOpenAIResponsesCompaction } from '../compaction-resource.ts';
import { internalErrorEnvelope } from '../errors.ts';
import { defineStage, move, defer, type Deferred } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

/**
 * The outermost edge.
 *
 * A compaction answers with one resource, so the frames never reach a client: they are read
 * here, which is also what stores each item the turn emitted under this gateway's own
 * response id. The resource that comes out is `CompactResource` and not the response
 * resource, so it is completed here rather than by the generate chain's egress — the fields
 * the two require are different, and a compaction decorated with the twenty-odd keys a
 * response resource declares would answer with a shape the spec does not give it.
 */
export const emitOpenAIResponsesCompaction = defineStage<
  Record<string, never>,
  Record<string, never>,
  Compacted<'response.chat.openaiResponses'> & Fields<'response.http.headers' | 'response.chat.openaiResponses.streamedUsage'>,
  Fields<'response.chat.openaiResponses.rendered' | 'response.http.status' | 'response.http.headers' | 'response.chat.openaiResponses.streamedUsage' | 'response.chat.clientFrames'>,
  ChatServices
>({
  name: 'emitOpenAIResponsesCompaction',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.openaiResponses', 'response.http.headers', 'response.chat.openaiResponses.streamedUsage'],
      consumes: ['response.chat.openaiResponses', 'response.http.headers'],
      provides: [
        'response.chat.clientFrames',
        'response.chat.openaiResponses.rendered',
        'response.http.status',
        'response.http.headers',
        'response.chat.openaiResponses.streamedUsage',
      ],
    },
  },
  execute: async (facts, next, use) => {
    const back = await next(facts);
    const { 'response.chat.openaiResponses': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      const failure = renderFailure(answer, mintedErrorEnvelope);
      return {
        ...rest,
        'response.chat.clientFrames': null,
        'response.http.headers': forClient,
        'response.chat.openaiResponses.rendered': move(failure.body),
        'response.http.status': failure.status,
      };
    }

    try {
      // The frames never reach a client, so the record is the only place they survive at all:
      // the tee sits above the stateful half, where they are this protocol's own and carry
      // the ids the resource below is assembled under. Reading is what records, and the fold
      // on the next line is the read.
      const frames = recordStream(
        wrapOpenAIResponsesStatefulOutput(answer.frames as AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>, use.gateway),
        use.gateway.dump,
      );
      const persisted = await collectOpenAIResponsesProtocolEventsToResult(frames);
      return {
        ...rest,
        'response.chat.clientFrames': move(frames),
        'response.http.headers': forClient,
        'response.chat.openaiResponses.rendered': move(
          completeOpenAIResponsesCompaction(persisted, openaiResponsesCreatedAt(use.gateway)) as unknown as Record<string, unknown>,
        ),
        'response.http.status': 200,
        'response.chat.openaiResponses.streamedUsage': move(
          withVerdict(rest['response.chat.openaiResponses.streamedUsage'], compactionFailed(persisted)),
        ),
      };
    } catch (error) {
      // Nothing has gone out yet, so the fault is still a status. A compaction the gateway
      // could not finish — an upstream that stated no counts, a turn that could not be
      // stored — is not one it can answer, and the client is told what broke.
      return {
        ...rest,
        'response.chat.clientFrames': null,
        'response.http.headers': forClient,
        'response.chat.openaiResponses.rendered': move(internalErrorEnvelope(error)),
        'response.http.status': 502,
        'response.chat.openaiResponses.streamedUsage': move(withVerdict(rest['response.chat.openaiResponses.streamedUsage'], true)),
      };
    }
  },
});

/** Whether the compaction resource says the turn behind it failed. `status` is not a key the
 *  compaction resource declares — it survives the spread from the turn the upstream actually
 *  ran, on either ending — and it is authoritative: a compaction that surfaced as failed
 *  belongs in the error column rather than masquerading as a success. */
const compactionFailed = (persisted: { readonly status?: string }): boolean => persisted.status === 'failed';

/** The accounting the epilogue settles from, with the verdict only the completed resource
 *  could give it. The edge is where a compaction resource comes into existence, so it is the
 *  one reader that can say whether the turn behind it succeeded.
 *
 *  What it composes is still this run's own unfinished work, so the result is declared too:
 *  the promise below it settles first, and the run must wait for the one it hands up. */
const withVerdict = (outcome: Deferred<StreamOutcome> | null, failed: boolean): Deferred<StreamOutcome> | null => {
  if (outcome === null || !failed) return outcome;
  return defer(outcome.then(read => ({ ...read, failed: true })));
};
