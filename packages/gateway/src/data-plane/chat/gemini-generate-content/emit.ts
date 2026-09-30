import { wrapGeminiGenerateContentAffinityEgress } from './affinity/egress.ts';
import { mintGeminiGenerateContentFailure } from './errors.ts';
import type { Fields } from './facts.ts';
import { recordStream, streamReferenceOf } from '../../../dump/run-sink.ts';
import { isFailure, renderFailure } from '../../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import type { ChatServices } from '../services.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult, geminiGenerateContentProtocolFrameToSSEFrame, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

/**
 * The outermost edge. A Gemini generateContent answer is always a stream by the time it reaches
 * here — the wire below speaks SSE whatever the client asked for, and the translation back into Gemini generateContent
 * is itself a stream of frames — so what this decides is whether the client sees the frames
 * or the one object they add up to.
 *
 * Collecting is therefore the edge's own work and not a second reading of the upstream: the
 * same frames that would have gone out are folded here instead.
 */
export const emitGeminiGenerateContent = defineStage<
  Fields<'ingress.chat.geminiGenerateContent.wantsStream'>,
  Fields<'ingress.chat.geminiGenerateContent.wantsStream'>,
  Fields<'ingress.chat.geminiGenerateContent.wantsStream' | 'response.chat.geminiGenerateContent' | 'response.http.headers'>,
  Fields<'response.chat.geminiGenerateContent.rendered' | 'response.http.status' | 'response.http.headers' | 'response.chat.clientFrames'>,
  ChatServices
>({
  name: 'emitGeminiGenerateContent',
  through: {
    request: {
      needs: ['ingress.chat.geminiGenerateContent.wantsStream'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.chat.geminiGenerateContent', 'response.http.headers'],
      consumes: ['response.chat.geminiGenerateContent', 'response.http.headers'],
      provides: ['response.chat.clientFrames', 'response.chat.geminiGenerateContent.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next, use) => {
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
        'response.chat.clientFrames': null,
        'response.http.headers': forClient,
        'response.chat.geminiGenerateContent.rendered': move(failure.body),
        'response.http.status': failure.status,
      };
    }
    if (answer.kind === 'value') {
      return {
        ...rest,
        'response.chat.clientFrames': null,
        'response.http.headers': forClient,
        'response.chat.geminiGenerateContent.rendered': move(answer.body as Record<string, unknown>),
        'response.http.status': 200,
      };
    }

    // The turn's own state, written back into the frames the client is handed: a follow-up
    // carrying it comes back to the upstream that issued it. This is the other half of the
    // affinity the resolver read on the way down, and it has to sit here because it rewrites
    // the frames — below the fold, and there would be nothing left to rewrite.
    const frames = recordStream(
      wrapGeminiGenerateContentAffinityEgress(
        answer.frames as AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
        affinityEgressOptions(use.gateway),
      ),
      use.gateway.dump,
    );
    if (!back['ingress.chat.geminiGenerateContent.wantsStream']) {
      return {
        ...rest,
        'response.chat.clientFrames': move(frames),
        'response.http.headers': forClient,
        'response.chat.geminiGenerateContent.rendered': move(
          await collectGeminiGenerateContentProtocolEventsToResult(frames) as unknown as Record<string, unknown>,
        ),
        'response.http.status': 200,
      };
    }
    return {
      ...rest,
      'response.chat.clientFrames': move(frames),
      'response.http.headers': forClient,
      'response.chat.geminiGenerateContent.rendered': move(renderSSE(frames)),
      'response.http.status': 200,
    };
  },
});

/** Gemini generateContent streams one JSON object per `data:` line and has no sentinel to write, which the
 *  protocol says by writing no frame at all for the one that ends the stream. */
const renderSSE = (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>): AsyncIterable<SseFrame> => ({
  // The frames the client reads are a reframing of the ones the record holds, so this key
  // points at that same stream rather than at nothing.
  ...streamReferenceOf(frames),
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) {
      const written = geminiGenerateContentProtocolFrameToSSEFrame(frame);
      if (written !== null) yield written;
    }
  })(),
});
