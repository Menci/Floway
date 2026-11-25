import { renderJsonResult, type ProtocolRenderer } from '../../pipeline/encode-response.ts';
import { encodeProtocolSse } from '../../shared/encode-protocol-sse.ts';
import { isOpenAIUsageOnlyEventShape, sseFrame } from '@floway-dev/protocols/common';

export const renderOpenAICompletions: ProtocolRenderer<'response.openaiCompletions'> = (outcome, http, delivery, scope) => {
  if (outcome.kind === 'result' && delivery.kind === 'json') return renderJsonResult(outcome, http);
  if (outcome.kind === 'stream' && delivery.kind === 'sse') {
    return encodeProtocolSse(http, outcome.stream, scope, event =>
      delivery.includeUsage || !isOpenAIUsageOnlyEventShape(event) ? sseFrame(JSON.stringify(event)) : null, sseFrame('[DONE]'));
  }
  throw new TypeError('OpenAI Completions outcome does not match the requested delivery');
};
