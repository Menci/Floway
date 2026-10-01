import { wrapAnthropicMessagesAffinityEgress } from './affinity/egress.ts';
import { renderAnthropicMessagesError } from './errors.ts';
import type { Fields } from './facts.ts';
import { recordStream } from '../../../dump/run-sink.ts';
import { isFailure, renderFailure, mintedAs } from '../../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import type { ChatServices } from '../services.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { bindClientRelease, collectClientFrames, framedClientStream, withClientVerdict } from '../shared/client-stream.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { collectAnthropicMessagesProtocolEventsToResult, anthropicMessagesEventToSsePayload, type AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, sseFrame, type EventFrame, type ProtocolFrame, type SseWritableFrame } from '@floway-dev/protocols/common';
import { toInternalDebugError } from '@floway-dev/provider';

/**
 * The outermost edge. An Anthropic Messages answer is always a stream by the time it reaches here —
 * the upstream speaks SSE whatever the client asked for — so what this decides is whether
 * the client sees the frames or the one message they add up to.
 *
 * Collecting is therefore the edge's own work and not a second reading of the upstream: the
 * same frames that would have gone out are folded here instead, by the protocol's own
 * reassembly. Neither shape can answer with half a message: the ending fails a stream that
 * ran out before `message_stop`, whichever of the two the client asked for.
 */
export const emitAnthropicMessages = defineStage<
  Fields<'ingress.chat.anthropicMessages.wantsStream'>,
  Fields<'ingress.chat.anthropicMessages.wantsStream'>,
  Fields<'ingress.chat.anthropicMessages.wantsStream' | 'response.chat.anthropicMessages' | 'response.http.headers' | 'response.http.status' | 'response.chat.anthropicMessages.streamedUsage'>,
  Fields<'response.chat.anthropicMessages.rendered' | 'response.http.status' | 'response.http.headers' | 'response.chat.clientFrames' | 'response.chat.anthropicMessages.streamedUsage'>,
  ChatServices
>({
  name: 'emitAnthropicMessages',
  through: {
    request: { needs: ['ingress.chat.anthropicMessages.wantsStream'], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.anthropicMessages', 'response.http.headers', 'response.http.status', 'response.chat.anthropicMessages.streamedUsage'],
      consumes: ['response.chat.anthropicMessages', 'response.http.headers'],
      provides: ['response.chat.clientFrames', 'response.chat.anthropicMessages.rendered', 'response.http.status', 'response.http.headers', 'response.chat.anthropicMessages.streamedUsage'],
    },
  },
  execute: async (facts, next, use) => {
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
        'response.chat.clientFrames': null,
        'response.http.headers': forClient,
        'response.chat.anthropicMessages.rendered': move(failure.body),
        'response.http.status': failure.status,
      };
    }
    if (answer.kind === 'value') {
      return {
        ...rest,
        'response.chat.clientFrames': null,
        'response.http.headers': forClient,
        'response.chat.anthropicMessages.rendered': move(answer.body as Record<string, unknown>),
        'response.http.status': back['response.http.status'],
      };
    }

    // The turn's own state, written back into the frames the client is handed: a follow-up
    // carrying it comes back to the upstream that issued it. This is the other half of the
    // affinity the resolver read on the way down, and it has to sit here because it rewrites
    // the frames — below the fold, and there would be nothing left to rewrite.
    const egress = wrapAnthropicMessagesAffinityEgress(
      answer.frames as AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>,
      affinityEgressOptions(use.gateway),
    );
    if (!back['ingress.chat.anthropicMessages.wantsStream']) {
      const frames = recordStream(egress, use.gateway.dump);
      return {
        ...rest,
        'response.chat.clientFrames': move(frames),
        'response.http.headers': forClient,
        'response.chat.anthropicMessages.rendered': move(
          await collectClientFrames(frames, collectAnthropicMessagesProtocolEventsToResult) as unknown as Record<string, unknown>,
        ),
        'response.http.status': back['response.http.status'],
      };
    }
    const completed = framedClientStream(
      clientFrames(egress),
      frame => sseFrame(JSON.stringify(frame.event), frame.event.type),
      error => [eventFrame({ type: 'error' as const, error: toInternalDebugError(error, 'anthropicMessages') })],
      use.gateway.dump,
    );
    bindClientRelease(back, completed.release);
    return {
      ...rest,
      'response.chat.clientFrames': move(completed.frames),
      'response.http.headers': forClient,
      'response.chat.anthropicMessages.rendered': move(completed.rendered),
      'response.chat.anthropicMessages.streamedUsage': move(withClientVerdict(back['response.chat.anthropicMessages.streamedUsage'], completed.failed)),
      'response.http.status': back['response.http.status'],
    };
  },
});

type ClientEvent = ReturnType<typeof anthropicMessagesEventToSsePayload>;

// SSE citations have their wire spelling before recording; the protocol's synthetic done
// frame has no Anthropic client form. Nonstream reassembly retains its canonical events.
const clientFrames = (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>): AsyncIterable<EventFrame<ClientEvent>> => ({
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) {
      if (frame.type === 'event') yield eventFrame(anthropicMessagesEventToSsePayload(frame.event));
    }
  })(),
});

/** What this protocol writes on an idle connection. Anthropic defines a `ping` event and
 *  clients read it, so an SSE comment — invisible by design — is not the same wire byte.
 *  The route that serves this chain hands it to the seam alongside the frames. */
export const anthropicMessagesKeepAlive: SseWritableFrame = sseFrame(JSON.stringify({ type: 'ping' }), 'ping');
