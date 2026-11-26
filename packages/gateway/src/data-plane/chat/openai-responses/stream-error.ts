import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/provider';

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
    ...(isJsonObject(failed) && failed.type === 'response.failed'
      ? { failed: failed as unknown as FailedResource } : {}),
  };
};

export const openAIResponsesProtocolError = (
  cause: unknown,
  events: OpenAIResponsesFailureEvents,
): ProtocolStreamError => {
  const event = events as JsonObject;
  return { kind: 'protocol', cause, ...Object.keys(event).length > 0 ? { event } : {} };
};

export const mapOpenAIResponsesFailedResource = async (
  error: ProtocolStreamError,
  transform: (event: FailedResource) => OpenAIResponsesStreamEventEx | Promise<OpenAIResponsesStreamEventEx>,
): Promise<ProtocolStreamError> => {
  const events = openAIResponsesFailureEvents(error);
  if (events.failed === undefined) return error;
  const failed = await transform(events.failed);
  if (failed === events.failed) return error;
  if (failed.type !== 'response.failed') throw new TypeError('OpenAI Responses failure transform changed the event type');
  return openAIResponsesProtocolError(error.cause, { ...events, failed });
};
