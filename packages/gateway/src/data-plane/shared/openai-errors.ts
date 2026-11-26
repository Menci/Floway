import { type InternalDebugError, internalDebugErrorFields } from '@floway-dev/provider';

export const openaiInternalErrorPayload = (error: InternalDebugError) => ({
  error: {
    type: error.type,
    message: error.message,
    provider_specific_fields: internalDebugErrorFields(error),
  },
});
