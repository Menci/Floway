import { wrapOpenAIResponsesClientEgress } from './client-output.ts';
import { internalErrorEnvelope } from './errors.ts';
import { OPENAI_RESPONSES_STREAMED_USAGE, type OpenAIResponsesStreamFraming, type Fields } from './facts.ts';
import { recordStream } from '../../../dump/run-sink.ts';
import { isFailure, renderFailure, mintedErrorEnvelope } from '../../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import type { ChatServices } from '../services.ts';
import { bindClientRelease, collectClientFrames, framedClientStream, withClientVerdict } from '../shared/client-stream.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, openaiResponsesProtocolFrameToSSEFrame, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesStreamEvent, type ClientOpenAIResponsesStreamEvent, type ClientResponseResource } from '@floway-dev/protocols/openai-responses';
import { toInternalDebugError } from '@floway-dev/provider';

/**
 * The outermost edge. What reaches it is usually a stream — the upstream speaks SSE whatever
 * the client asked for — so what this decides is whether the client sees the frames or the
 * one response object they add up to.
 *
 * Collecting is therefore the edge's own work and not a second reading of the upstream: the
 * same frames that would have gone out are folded here instead, by the protocol's own
 * reassembly, which is what makes a stream that stopped short of its terminal event say so
 * rather than answer with half a response.
 *
 * The stored-items membrane's other half runs here too, and it takes the client's own
 * payload rather than the record's, because by the fork the record holds the prepared one —
 * `previous_response_id` expanded away — and the resource echoes what the client asked with.
 *
 * A streamed answer is handed on in the framing the transport that opened the run writes.
 * Only the last step differs: `renderSSE` is a wire format written over an HTTP body, and a
 * transport that frames each event itself takes the events it would have been written from.
 */
export const emitOpenAIResponses = (client: CanonicalOpenAIResponsesPayload, framing: OpenAIResponsesStreamFraming) => defineStage<
  Fields<'ingress.chat.openaiResponses.wantsStream'>,
  Fields<'ingress.chat.openaiResponses.wantsStream'>,
  Fields<'ingress.chat.openaiResponses.wantsStream' | 'response.chat.openaiResponses' | 'response.http.headers' | 'response.chat.openaiResponses.streamedUsage'>,
  Fields<'response.chat.openaiResponses.rendered' | 'response.http.status' | 'response.http.headers' | 'response.chat.clientFrames' | 'response.chat.openaiResponses.streamedUsage'>,
  ChatServices
>({
  name: 'emitOpenAIResponses',
  through: {
    request: { needs: ['ingress.chat.openaiResponses.wantsStream'], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.openaiResponses', 'response.http.headers', OPENAI_RESPONSES_STREAMED_USAGE],
      consumes: ['response.chat.openaiResponses', 'response.http.headers'],
      provides: ['response.chat.clientFrames', 'response.chat.openaiResponses.rendered', 'response.http.status', 'response.http.headers', OPENAI_RESPONSES_STREAMED_USAGE],
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
    // A turn the upstream answered with one body rather than a stream — the compaction
    // envelope — is already the object the client is owed, so there is nothing to fold.
    if (answer.kind === 'value') {
      return {
        ...rest,
        'response.chat.clientFrames': null,
        'response.http.headers': forClient,
        'response.chat.openaiResponses.rendered': move(answer.body as Record<string, unknown>),
        'response.http.status': 'response.http.status' in back ? back['response.http.status'] as number : 200,
      };
    }

    // Everything this protocol writes back into its own frames, in one place because every
    // layer of it rewrites them and below the fold there would be nothing left to rewrite:
    // the turn's own state sealed into the carrier a follow-up comes back on, each complete
    // item stored under its exact id beneath one response id this gateway minted, and the resource
    // completed to what the schema requires of it. It runs before the fold rather than beside it,
    // so a client that did not ask to stream is answered with the object the persisted frames
    // add up to.
    const egress = wrapOpenAIResponsesClientEgress(
      answer.frames as AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
      use.gateway,
      client,
    );
    // HTTP records the client-facing protocol before writing SSE or folding it into a
    // resource. WebSocket records later, after its event-id/sequence/error projection.
    if (!back['ingress.chat.openaiResponses.wantsStream']) {
      const frames = recordStream(egress, use.gateway.dump);
      try {
        return {
          ...rest,
          'response.chat.clientFrames': move(frames),
          'response.http.headers': forClient,
          'response.chat.openaiResponses.rendered': move(
            await collectClientFrames(frames, collectOpenAIResponsesProtocolEventsToResult) as unknown as Record<string, unknown>,
          ),
          'response.http.status': 'response.http.status' in back ? back['response.http.status'] as number : 200,
        };
      } catch (error) {
        // Nothing has gone out yet, so the fault is still a status. A turn the gateway could
        // not finish — the snapshot the next turn would read, most often — is not one it can
        // answer, and the client is told what broke rather than handed the half that arrived.
        use.gateway.dump?.failed(error);
        return {
          ...rest,
          'response.chat.clientFrames': move(frames),
          'response.http.headers': forClient,
          'response.chat.openaiResponses.rendered': move(internalErrorEnvelope(error)),
          'response.http.status': 502,
          [OPENAI_RESPONSES_STREAMED_USAGE]: move(withClientVerdict(back[OPENAI_RESPONSES_STREAMED_USAGE], Promise.resolve(true))),
        };
      }
    }
    if (framing === 'events') {
      const clientStream = completeEventStream(egress, error => { use.gateway.dump?.failed(error); });
      const frames = clientStream.frames;
      bindClientRelease(back, clientStream.release);
      return {
        ...rest,
        'response.chat.clientFrames': move(frames),
        'response.http.headers': forClient,
        'response.chat.openaiResponses.rendered': move(frames),
        'response.http.status': 'response.http.status' in back ? back['response.http.status'] as number : 200,
        [OPENAI_RESPONSES_STREAMED_USAGE]: move(withClientVerdict(back[OPENAI_RESPONSES_STREAMED_USAGE], clientStream.failed)),
      };
    }
    let announced: ClientResponseResource | undefined;
    const completed = framedClientStream(
      completedSseFrames(egress),
      frame => {
        const wire = openaiResponsesProtocolFrameToSSEFrame(frame);
        if (frame.type === 'event' && 'response' in frame.event) announced = frame.event.response;
        return wire;
      },
      error => [eventFrame(streamErrorEvent(error)), ...(announced === undefined ? [] : [eventFrame(streamFailedEvent(announced, error))])],
      use.gateway.dump,
    );
    bindClientRelease(back, completed.release);
    return {
      ...rest,
      'response.chat.clientFrames': move(completed.frames),
      'response.http.headers': forClient,
      'response.chat.openaiResponses.rendered': move(completed.rendered),
      'response.http.status': 'response.http.status' in back ? back['response.http.status'] as number : 200,
      [OPENAI_RESPONSES_STREAMED_USAGE]: move(withClientVerdict(back[OPENAI_RESPONSES_STREAMED_USAGE], completed.failed)),
    };
  },
});

/** The spec nests the `error` event's payload under `error`, and both official SDKs key
 *  their mid-stream throw on exactly that key; the same fields at the top level are yielded
 *  to them as an ordinary event instead.
 *  https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L170-L177
 *  https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/core/streaming.ts#L69-L71
 *  https://github.com/openai/openai-python/blob/3844843c277f42b0b18beaa58152cfda61df524a/src/openai/_streaming.py#L87-L98 */
const streamErrorEvent = (error: unknown): ClientOpenAIResponsesStreamEvent => {
  const debug = toInternalDebugError(error);
  return {
    type: 'error',
    error: {
      message: debug.message,
      code: debug.type,
      name: debug.name,
      stack: debug.stack,
      cause: debug.cause,
      target_api: debug.target_api,
    },
  } as unknown as ClientOpenAIResponsesStreamEvent;
};

/** "Any error incurred while streaming will be followed by a `response.failed` event."
 *  https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L430 */
const streamFailedEvent = (announced: ClientResponseResource, error: unknown): ClientOpenAIResponsesStreamEvent => {
  const debug = toInternalDebugError(error);
  return {
    type: 'response.failed',
    response: { ...announced, status: 'failed', error: { code: debug.type, message: debug.message } },
  } as ClientOpenAIResponsesStreamEvent;
};

const completeEventStream = (
  frames: AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>,
  reportFailure: (error: unknown) => void,
): { frames: AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>; failed: Promise<boolean>; release: () => Promise<void> } => {
  let settle!: (failed: boolean) => void;
  const failed = new Promise<boolean>(resolve => { settle = resolve; });
  let started = false;
  const stream = (async function* () {
    started = true;
    let failed = false;
    let completed = false;
    try {
      for await (const frame of frames) if (frame.type !== 'done') yield frame;
      completed = true;
    } catch (error) {
      failed = true;
      reportFailure(error);
      throw error;
    } finally {
      settle(failed || !completed);
    }
  })();
  return {
    frames: { [Symbol.asyncIterator]: () => stream }, failed, release: async () => {
      if (!started) settle(true);
      await stream.return();
    },
  };
};

const completedSseFrames = (frames: AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>): AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>> => ({
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) if (frame.type !== 'done') yield frame;
    yield doneFrame();
  })(),
});
