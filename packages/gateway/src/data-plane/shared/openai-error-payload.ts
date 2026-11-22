import { isJsonObject } from '@floway-dev/protocols/common';
import { type InternalDebugError, internalDebugErrorFields } from '@floway-dev/provider';

export const openaiInternalErrorPayload = (error: InternalDebugError) => ({
  error: {
    type: error.type,
    message: error.message,
    provider_specific_fields: internalDebugErrorFields(error),
  },
});

export const isOpenAIErrorPayload = (value: unknown): boolean =>
  isJsonObject(value) && isJsonObject(value.error) && typeof value.error.message === 'string';
