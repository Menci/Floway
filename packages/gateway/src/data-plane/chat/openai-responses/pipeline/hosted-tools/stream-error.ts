import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/upstream';

type FailureNotification = Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>;
type FailedResource = Extract<OpenAIResponsesStreamEventEx, { type: 'response.failed' }>;

interface OpenAIResponsesFailureEvents {
  notification?: FailureNotification;
  failed?: FailedResource;
}

export const openAIResponsesFailureEvents = (error: ProtocolStreamError): OpenAIResponsesFailureEvents => {
  if (error.kind !== 'protocol' || error.event === undefined) return {};
  const { notification, failed } = error.event;
  return {
    ...(isJsonObject(notification) && notification.type === 'error'
      ? { notification: notification as unknown as FailureNotification } : {}),
    ...(isJsonObject(failed) && failed.type === 'response.failed' && isJsonObject(failed.response)
      ? { failed: failed as unknown as FailedResource } : {}),
  };
};

export const openAIResponsesProtocolError = (
  cause: unknown,
  events: OpenAIResponsesFailureEvents,
): ProtocolStreamError => {
  const event = { ...events };
  return { kind: 'protocol', cause, ...(Object.keys(event).length > 0 ? { event } : {}) };
};
