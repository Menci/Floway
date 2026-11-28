import type { HttpErrorResponse } from '../../../composition/index.ts';
import type { IRErrorPayload } from '../../../ir/output/error.ts';
import {
  extractStandardIRError,
  irErrorFromStandardWire,
  parseJSONErrorBody,
  unwrapErrorEnvelope,
} from '../../../shared/api-error.ts';
import { isPlainJSONObject } from '../../../shared/json/object.ts';

const messagesTransportFields = (envelope: Readonly<Record<string, unknown>>): readonly string[] =>
  envelope.type === 'error' ? ['type'] : [];

export const readAnthropicMessagesErrorBody = ({ body }: HttpErrorResponse): IRErrorPayload | undefined => {
  const parsed = parseJSONErrorBody(body);
  if (!isPlainJSONObject(parsed)) return undefined;
  const { source, envelopeDetails } = unwrapErrorEnvelope(parsed, messagesTransportFields(parsed));
  return extractStandardIRError(source, envelopeDetails, { requireMessage: true });
};

export const anthropicMessagesErrorFromEvent = (event: unknown): IRErrorPayload => {
  const record = isPlainJSONObject(event) ? event : {};
  const { source, envelopeDetails } = unwrapErrorEnvelope(record, messagesTransportFields(record));
  return irErrorFromStandardWire(source, envelopeDetails);
};
