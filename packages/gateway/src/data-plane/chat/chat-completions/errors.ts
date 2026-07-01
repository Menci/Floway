import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import type { TranslatorInputError } from '@floway-dev/translate';

// OpenAI error envelope. `param`/`code` reproduce OpenAI's native fields; a
// stored-item miss must byte-match OpenAI's own "not found" body. The
// envelope is gateway-synthesized — `source: 'gateway'` so the dump labels
// it as such.
const openAiErrorResult = (
  status: number,
  message: string,
  extra?: { param: string; code: string | null },
): ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> => ({
  type: 'api-error',
  source: 'gateway',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify({
    error: { message, type: 'invalid_request_error', ...extra },
  })),
});

// Translator surfaced a caller-input violation. Render as a 400
// invalid_request_error so the caller sees a protocol-shaped failure
// instead of the internal-error 502 envelope. `param` falls back to
// `messages` (the Chat Completions canonical messages field) when the
// translator did not carry a more specific path.
export const translatorInputErrorResult = (
  error: TranslatorInputError,
): ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> =>
  openAiErrorResult(400, error.message, { param: error.param ?? 'messages', code: null });

export const renderChatCompletionsFailure = (
  failure: ChatServeFailure,
): ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> => {
  switch (failure.kind) {
  case 'item-not-found':
    return openAiErrorResult(404, `Item with id '${failure.itemId}' not found.`, { param: 'input', code: null });
  case 'routing-unavailable':
    return openAiErrorResult(400, failure.message, { param: 'input', code: 'responses_item_routing_unavailable' });
  case 'model-missing':
    return openAiErrorResult(404, appendFailedUpstreams(`Model ${failure.model} is not available on any configured upstream.`, failure.failedUpstreams));
  case 'model-unsupported':
    return openAiErrorResult(400, appendFailedUpstreams(`Model ${failure.model} does not support the /chat/completions endpoint.`, failure.failedUpstreams));
  }
};
