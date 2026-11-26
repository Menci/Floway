import { encode, encodedResponse, encodeStream, jsonResponse, localResponseHead, type EncoderScope } from '../pipeline/encode.ts';
import { openaiInternalErrorPayload } from '../shared/openai-errors.ts';
import { serializeSseFrame } from '../shared/sse.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import { sseFrame } from '@floway-dev/protocols/common';
import { toInternalDebugError, type GatewayFacts } from '@floway-dev/provider';

type ImagesOperation = 'openaiImagesGenerations' | 'openaiImagesEdits';

const sseEncoder = new TextEncoder();
const frame = (value: unknown) => [sseEncoder.encode(serializeSseFrame(sseFrame(JSON.stringify(value))))];

const renderImages = (
  { http, outcome }: { http: Omit<HttpResponseFact, 'body'> | null; outcome: GatewayFacts[`response.${ImagesOperation}`] },
  scope: EncoderScope,
): HttpResponseFact => {
  if (outcome.kind === 'error') {
    return jsonResponse(http ?? localResponseHead(outcome.source === 'upstream' ? 502 : 499), outcome.error);
  }
  if (http === null) throw new Error('OpenAI Images success requires an HTTP response');
  if (outcome.kind === 'result') return jsonResponse(http, outcome.result);

  const body = encodeStream(outcome.stream, scope, item => {
    if (item.ok) return frame(item.value);
    if (item.error.kind === 'abort') return [];
    const error = item.error.kind === 'protocol' && item.error.event !== undefined
      ? item.error.event
      : openaiInternalErrorPayload(toInternalDebugError(item.error.cause));
    return frame(error);
  });
  return encodedResponse(http, body, 'text/event-stream');
};

export const encodeOpenAIImagesGenerations = encode('openaiImagesGenerations', renderImages);
export const encodeOpenAIImagesEdits = encode('openaiImagesEdits', renderImages);
