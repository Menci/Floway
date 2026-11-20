import { wrapGeminiGenerateContentAffinityEgress } from './affinity/egress.ts';
import { renderGeminiGenerateContentFailure, mintGeminiGenerateContentInternalFailure } from './errors.ts';
import type { Fields } from './facts.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import type { ChatServices } from '../services.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { bindClientRelease, collectClientFrames, framedClientStream, withClientVerdict } from '../shared/client-stream.ts';
import { recordStream } from '@floway-dev/dump';
import { defer, defineStage, move } from '@floway-dev/pipeline';
import { eventFrame, isJsonObject, type EventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult, createGeminiGenerateContentCandidateCompletion, geminiGenerateContentProtocolFrameToSSEFrame, isGeminiGenerateContentErrorEvent, isGeminiGenerateContentTerminalEvent, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { toInternalDebugError } from '@floway-dev/provider';

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
  Fields<'ingress.chat.geminiGenerateContent.wantsStream' | 'response.chat.geminiGenerateContent' | 'response.http.headers' | 'response.http.status' | 'response.chat.geminiGenerateContent.streamedUsage'>,
  Fields<'response.chat.geminiGenerateContent.rendered' | 'response.http.status' | 'response.http.headers' | 'response.chat.clientFrames' | 'response.chat.geminiGenerateContent.streamedUsage'>,
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
      needs: ['response.chat.geminiGenerateContent', 'response.http.headers', 'response.http.status', 'response.chat.geminiGenerateContent.streamedUsage'],
      consumes: ['response.chat.geminiGenerateContent', 'response.http.headers'],
      provides: ['response.chat.clientFrames', 'response.chat.geminiGenerateContent.rendered', 'response.http.status', 'response.http.headers', 'response.chat.geminiGenerateContent.streamedUsage'],
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
      const failure = renderGeminiGenerateContentFailure(answer);
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
        'response.http.status': back['response.http.status'],
      };
    }

    // The turn's own state, written back into the frames the client is handed: a follow-up
    // carrying it comes back to the upstream that issued it. This is the other half of the
    // affinity the resolver read on the way down, and it has to sit here because it rewrites
    // the frames — below the fold, and there would be nothing left to rewrite.
    const source = answer.frames as AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>;
    const completion = createGeminiGenerateContentCandidateCompletion();
    let terminal: 'completed' | 'failed' | undefined;
    const observed = (async function* () {
      for await (const frame of source) {
        if (frame.type === 'done') terminal = 'completed';
        else if (isGeminiGenerateContentErrorEvent(frame.event)) terminal = 'failed';
        else if (isGeminiGenerateContentTerminalEvent(frame.event)) terminal = 'completed';
        else completion.observe(frame.event);
        yield frame;
        if (terminal !== undefined) return;
      }
    })();
    const egress = wrapGeminiGenerateContentAffinityEgress(observed, affinityEgressOptions(use.gateway));
    if (!back['ingress.chat.geminiGenerateContent.wantsStream']) {
      const frames = recordStream(egress, use.gateway.dump);
      try {
        return {
          ...rest,
          'response.chat.clientFrames': move(frames),
          'response.http.headers': forClient,
          'response.chat.geminiGenerateContent.rendered': move(
            await collectClientFrames(frames, collectGeminiGenerateContentProtocolEventsToResult) as unknown as Record<string, unknown>,
          ),
          'response.http.status': back['response.http.status'],
        };
      } catch (error) {
        use.gateway.dump?.failed(error);
        const cause = error instanceof Error ? error.cause : undefined;
        const failure = isJsonObject(cause) && isJsonObject(cause.error)
          ? renderGeminiGenerateContentFailure({ status: 502, message: error instanceof Error ? error.message : String(error), body: cause })
          : mintGeminiGenerateContentInternalFailure(502, toInternalDebugError(error, 'geminiGenerateContent'));
        return {
          ...rest,
          'response.chat.clientFrames': move(frames),
          'response.http.headers': forClient,
          'response.chat.geminiGenerateContent.rendered': move(failure.body),
          'response.http.status': failure.status,
          'response.chat.geminiGenerateContent.streamedUsage': move(withClientVerdict(back['response.chat.geminiGenerateContent.streamedUsage'], Promise.resolve(true))),
        };
      }
    }
    const completed = framedClientStream(
      clientFrames(egress),
      frame => geminiGenerateContentProtocolFrameToSSEFrame(frame)!,
      error => [eventFrame(geminiStreamError(error))],
      use.gateway.dump,
    );
    bindClientRelease(back, completed.release);
    // Affinity can hold a final frame while the client cancels. Settlement
    // follows the upstream completion already observed before that buffer.
    const metered = back['response.chat.geminiGenerateContent.streamedUsage'];
    const reading = metered === null ? null : defer(Promise.all([metered, completed.failed]).then(([outcome, failed]) => {
      const completedBeforeAbort = use.gateway.abortSignal?.aborted === true
        && (terminal === 'completed' || (terminal === undefined && completion.isComplete()));
      return { ...outcome, failed: (outcome.failed || failed) && !completedBeforeAbort };
    }));
    return {
      ...rest,
      'response.chat.clientFrames': move(completed.frames),
      'response.http.headers': forClient,
      'response.chat.geminiGenerateContent.rendered': move(completed.rendered),
      'response.chat.geminiGenerateContent.streamedUsage': move(reading),
      'response.http.status': back['response.http.status'],
    };
  },
});

const clientFrames = (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>): AsyncIterable<EventFrame<GeminiGenerateContentStreamEvent>> => ({
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) if (frame.type === 'event') yield frame;
  })(),
});

const geminiStreamError = (error: unknown): GeminiGenerateContentStreamEvent =>
  mintGeminiGenerateContentInternalFailure(500, toInternalDebugError(error, 'geminiGenerateContent')).body;
