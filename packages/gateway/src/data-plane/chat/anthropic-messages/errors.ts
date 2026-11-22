import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import type { ChatAttemptOutcome } from '../pipeline/index.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import { generateAnthropicId } from '@floway-dev/protocols/anthropic-messages';

const anthropicMessagesApiErrorOutcome = (
  status: number,
  type: string,
  message: string,
): Extract<ChatAttemptOutcome<never>, { type: 'api-error' }> => ({
  type: 'api-error',
  source: 'gateway',
  http: {
    status,
    headers: Object.freeze([Object.freeze(['content-type', 'application/json'] as const)]),
  },
  body: new TextEncoder().encode(JSON.stringify({
    type: 'error',
    error: { type, message },
    request_id: generateAnthropicId('req'),
  })),
});

export const anthropicMessagesFailureOutcome = (
  failure: ChatServeFailure,
  endpoint: 'generate' | 'countTokens',
): Extract<ChatAttemptOutcome<never>, { type: 'api-error' }> => {
  const endpointPath = endpoint === 'countTokens' ? '/messages/count_tokens' : '/messages';
  switch (failure.kind) {
  case 'routing-unavailable':
    return anthropicMessagesApiErrorOutcome(400, 'invalid_request_error', failure.message);
  case 'model-missing':
    return anthropicMessagesApiErrorOutcome(
      404,
      'not_found_error',
      appendFailedUpstreams(`Model ${failure.model} is not available on any configured upstream.`, failure.failedUpstreams),
    );
  case 'model-unsupported':
    return anthropicMessagesApiErrorOutcome(
      400,
      'invalid_request_error',
      appendFailedUpstreams(`Model ${failure.model} does not support the ${endpointPath} endpoint.`, failure.failedUpstreams),
    );
  }
};
