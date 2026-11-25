import type { ProtocolRenderer } from '../../pipeline/encode-response.ts';
import { encodeProtocolSse } from '../../shared/encode-protocol-sse.ts';
import { sseFrame } from '@floway-dev/protocols/common';

export const renderOpenAIAudioTranscriptions: ProtocolRenderer<'response.openaiAudioTranscriptions'> = (outcome, http, delivery, scope) => {
  if (delivery.kind !== 'bytes' && delivery.kind !== 'sse') throw new TypeError('OpenAI Audio Transcriptions needs a bytes or SSE delivery');
  if (outcome.kind === 'result') return { ...http, body: outcome.result };
  return encodeProtocolSse({ ...http, status: 200, statusText: 'OK' }, outcome.stream, scope, event => sseFrame(JSON.stringify(event)));
};
