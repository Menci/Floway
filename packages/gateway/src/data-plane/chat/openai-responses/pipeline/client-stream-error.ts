import { openAIResponsesFailureEvents } from '../../pipeline/stream-error.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/upstream';

export const mapOpenAIResponsesFailedResource = async (
  error: ProtocolStreamError,
  map: (event: OpenAIResponsesStreamEventEx) => OpenAIResponsesStreamEventEx | Promise<OpenAIResponsesStreamEventEx>,
): Promise<ProtocolStreamError> => {
  if (error.kind !== 'protocol') return error;
  const { failed } = openAIResponsesFailureEvents(error);
  if (failed === undefined || !isJsonObject(failed.response) || !Array.isArray(failed.response.output)) return error;
  return { ...error, event: { ...error.event, failed: await map(failed) } };
};
