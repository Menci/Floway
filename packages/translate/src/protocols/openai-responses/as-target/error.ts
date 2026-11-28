import type { HttpErrorResponse } from '../../../composition/index.ts';
import type { IRErrorPayload } from '../../../ir/output/error.ts';
import {
  extractStandardIRError,
  irErrorFromStandardWire,
  parseJSONErrorBody,
  unwrapErrorEnvelope,
} from '../../../shared/api-error.ts';
import { isPlainJSONObject } from '../../../shared/json/object.ts';

const responsesTransportFields = (envelope: Readonly<Record<string, unknown>>): readonly string[] =>
  envelope.type === 'error' ? ['type', 'sequence_number'] : [];

export const readOpenAIResponsesErrorBody = ({ body }: HttpErrorResponse): IRErrorPayload | undefined => {
  const parsed = parseJSONErrorBody(body);
  if (!isPlainJSONObject(parsed)) return undefined;
  const { source, envelopeDetails } = unwrapErrorEnvelope(parsed, responsesTransportFields(parsed));
  return extractStandardIRError(source, envelopeDetails, { requireMessage: true });
};

export const openaiResponsesErrorFromEvent = (event: unknown): IRErrorPayload => {
  const record = isPlainJSONObject(event) ? event : {};
  const { source, envelopeDetails } = unwrapErrorEnvelope(record, responsesTransportFields(record));
  return irErrorFromStandardWire(source, envelopeDetails);
};

export const openaiResponsesErrorFromFailed = (error: unknown): IRErrorPayload => {
  const { source, envelopeDetails } = unwrapErrorEnvelope(isPlainJSONObject(error) ? error : {});
  return irErrorFromStandardWire(source, envelopeDetails);
};
