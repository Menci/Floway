import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/upstream';

type OpenAIResponsesErrorEvent = Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>;
type OpenAIResponsesFailedEvent = Extract<OpenAIResponsesStreamEventEx, { type: 'response.failed' }>;

export const openAIResponsesFailureEvents = (error: ProtocolStreamError): {
  notification?: OpenAIResponsesErrorEvent;
  failed?: OpenAIResponsesFailedEvent;
} => {
  if (error.kind !== 'protocol' || error.event === undefined) return {};
  const { notification, failed } = error.event;
  return {
    ...(isJsonObject(notification) && notification.type === 'error'
      ? { notification: notification as unknown as OpenAIResponsesErrorEvent } : {}),
    ...(isJsonObject(failed) && failed.type === 'response.failed'
      ? { failed: failed as unknown as OpenAIResponsesFailedEvent } : {}),
  };
};

export const openAIResponsesStreamErrorPayload = (event: OpenAIResponsesErrorEvent): JsonObject => {
  const { type: _type, sequence_number: _sequenceNumber, ...fields } = event;
  return 'error' in fields && isJsonObject(fields.error) ? fields.error : fields;
};
