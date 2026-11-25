import { localResponseHead } from '../../pipeline/encode.ts';
import { generateAnthropicId } from '@floway-dev/protocols/anthropic-messages';
import { internalDebugErrorFields, type InternalDebugError } from '@floway-dev/provider';

export const anthropicMessagesInternalErrorPayload = (error: InternalDebugError) => ({
  type: 'error',
  error: {
    type: error.type,
    message: error.message,
    provider_specific_fields: internalDebugErrorFields(error),
  },
});

export const anthropicMessagesLocalError = (status: number, type: string, message: string, extension?: Record<string, unknown>) => ({
  http: { ...localResponseHead(status), body: null },
  outcome: {
    kind: 'error' as const,
    source: 'local' as const,
    error: {
      type: 'error',
      error: { type, message, ...(extension === undefined ? {} : { provider_specific_fields: extension }) },
      request_id: generateAnthropicId('req'),
    },
  },
});
