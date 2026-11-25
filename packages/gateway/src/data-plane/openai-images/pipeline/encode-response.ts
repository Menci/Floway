import { renderJsonResult, type ProtocolRenderer } from '../../pipeline/encode-response.ts';
import { encodeProtocolSse } from '../../shared/encode-protocol-sse.ts';
import { sseFrame } from '@floway-dev/protocols/common';

export const renderOpenAIImages: ProtocolRenderer<'response.openaiImagesGenerations' | 'response.openaiImagesEdits'> =
  (outcome, http, delivery, scope) => {
    if (outcome.kind === 'result') return renderJsonResult(outcome, http);
    if (delivery.kind !== 'sse') throw new TypeError('OpenAI Images returned a stream for JSON delivery');
    return encodeProtocolSse(http, outcome.stream, scope, event => sseFrame(JSON.stringify(event), event.type));
  };
