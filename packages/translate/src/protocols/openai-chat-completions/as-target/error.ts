import type { HttpErrorResponse } from '../../../composition/index.ts';
import type { IRErrorPayload } from '../../../ir/output/error.ts';
import {
  extractStandardIRError,
  irErrorFromStandardWire,
  parseJSONErrorBody,
  unwrapErrorEnvelope,
} from '../../../shared/api-error.ts';
import { isPlainJSONObject } from '../../../shared/json/object.ts';

export const readOpenAIChatCompletionsErrorBody = ({ body }: HttpErrorResponse): IRErrorPayload | undefined => {
  const parsed = parseJSONErrorBody(body);
  if (!isPlainJSONObject(parsed)) return undefined;
  const { source, envelopeDetails } = unwrapErrorEnvelope(parsed);
  return extractStandardIRError(source, envelopeDetails, { requireMessage: true });
};

export const openaiChatCompletionsErrorFromEvent = (error: unknown): IRErrorPayload => {
  const { source, envelopeDetails } = unwrapErrorEnvelope(isPlainJSONObject(error) ? error : {});
  return irErrorFromStandardWire(source, envelopeDetails);
};
