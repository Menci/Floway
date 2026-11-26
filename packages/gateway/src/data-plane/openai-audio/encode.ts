import { encode, encodedResponse, encodeStream, jsonResponse, localResponseHead, type EncoderScope } from '../pipeline/encode.ts';
import { openaiInternalErrorPayload } from '../shared/openai-errors.ts';
import { serializeSseFrame } from '../shared/sse.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import type { ManagedStream } from '@floway-dev/pipeline';
import { sseFrame } from '@floway-dev/protocols/common';
import { toInternalDebugError, type ProtocolError, type ProtocolStreamError } from '@floway-dev/provider';

type AudioOutcome<Event> =
  | ProtocolError
  | { kind: 'result'; result: Uint8Array }
  | { kind: 'stream'; stream: ManagedStream<Event, ProtocolStreamError> };

const sseEncoder = new TextEncoder();
const frame = (value: unknown, eventName?: string) => [sseEncoder.encode(serializeSseFrame(sseFrame(JSON.stringify(value), eventName)))];

const renderAudio = <Event>(
  { http, outcome }: { http: Omit<HttpResponseFact, 'body'> | null; outcome: AudioOutcome<Event> },
  scope: EncoderScope,
  renderEvent: (event: Event) => Uint8Array[],
): HttpResponseFact => {
  if (outcome.kind === 'error') {
    return jsonResponse(http ?? localResponseHead(outcome.source === 'upstream' ? 502 : 499), outcome.error);
  }
  if (http === null) throw new Error('OpenAI Audio success requires an HTTP response');
  if (outcome.kind === 'result') return encodedResponse(http, outcome.result);

  const body = encodeStream(outcome.stream, scope, item => {
    if (item.ok) return renderEvent(item.value);
    if (item.error.kind === 'abort') return [];
    if (item.error.kind === 'protocol' && item.error.event !== undefined) {
      return frame(item.error.event, item.error.eventName);
    }
    return frame(openaiInternalErrorPayload(toInternalDebugError(item.error.cause)));
  });
  return encodedResponse(http, body, 'text/event-stream');
};

export const encodeOpenAIAudioTranscriptions = encode('openaiAudioTranscriptions', (input, scope) =>
  renderAudio(input, scope, ({ data, eventName }) => frame(data, eventName)));
export const encodeOpenAIAudioSpeech = encode('openaiAudioSpeech', (input, scope) => renderAudio(input, scope, frame));
