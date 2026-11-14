import { renderFailure, type Failure, type RenderedFailure } from '../../pipeline/facts.ts';
import { inputErrorFields, type InputErrorDetails } from '../shared/errors.ts';
import { geminiGenerateContentStatusForHttpStatus, type GeminiGenerateContentErrorResponse } from '@floway-dev/protocols/gemini-generate-content';
import { internalDebugErrorFields, type InternalDebugError } from '@floway-dev/provider';

// Google RPC Status envelope, used by Gemini's `error` channel everywhere
// (HTTP body, SSE-tunnelled error event).

/** A synthesized Google RPC envelope uses 500 when the original HTTP code has no named
 *  counterpart. The source edge applies the same rule to translated envelopes. */
export const mintGeminiGenerateContentFailure = (failure: {
  readonly status: number;
  readonly message: string;
  readonly details?: readonly Record<string, unknown>[];
}): {
  readonly body: GeminiGenerateContentErrorResponse;
  readonly status: number;
} => {
  const status = statusName(failure.status) === 'INTERNAL' ? 500 : failure.status;
  return {
    body: {
      error: {
        code: status,
        message: failure.message,
        status: statusName(status),
        ...(failure.details === undefined ? {} : { details: [...failure.details] }),
      },
    },
    status,
  };
};

/** The same refusal as an HTTP response, for the edges that answer before a pipeline runs. */
export const geminiGenerateContentErrorResponse = (status: number, message: string): Response => {
  const failure = mintGeminiGenerateContentFailure({ status, message });
  return Response.json(failure.body, { status: failure.status });
};

// ProtoJSON Any encodes the well-known Struct's arbitrary JSON under value.
// https://protobuf.dev/programming-guides/json/#any
// https://github.com/googleapis/googleapis/blob/e09e85d32ca349e1b205514a412817a7692595c6/google/rpc/error_details.proto#L97-L104
const structDetail = (value: Record<string, unknown>) => ({ '@type': 'type.googleapis.com/google.protobuf.Struct', value });

/** A gateway fault with its diagnostics: the stack as DebugInfo and the remaining fields as a
 *  Struct, which is where Google RPC carries detail a client may log. */
export const mintGeminiGenerateContentInternalFailure = (status: number, error: InternalDebugError) => {
  const { stack, ...fields } = internalDebugErrorFields(error);
  return mintGeminiGenerateContentFailure({
    status,
    message: error.message,
    details: [
      ...(stack === undefined ? [] : [{ '@type': 'type.googleapis.com/google.rpc.DebugInfo', stackEntries: stack.split('\n') }]),
      structDetail({ type: error.type, ...fields }),
    ],
  });
};

/** A request this protocol cannot carry to the selected target, with the field it names. */
export const mintGeminiGenerateContentInputFailure = (error: InputErrorDetails) => {
  const fields = inputErrorFields(error);
  return mintGeminiGenerateContentFailure({ status: 400, message: error.message, ...(fields === undefined ? {} : { details: [structDetail(fields)] }) });
};

/** The Google-RPC name for an HTTP status. Private, because a caller holding only the name
 *  can write an envelope whose code contradicts it — which is the whole reason the two are
 *  minted together above. */
const statusName = (status: number): string => {
  switch (status) {
  case 400:
  case 401:
  case 403:
  case 404:
  case 429:
  case 500:
  case 502:
  case 503:
    return geminiGenerateContentStatusForHttpStatus(status)!;
  default:
    return 'INTERNAL';
  }
};

export const renderGeminiGenerateContentFailure = (failure: Failure): RenderedFailure => {
  const rendered = renderFailure(failure, mintGeminiGenerateContentFailure);
  const body = rendered.body as GeminiGenerateContentErrorResponse;
  if (statusName(rendered.status) !== 'INTERNAL' || rendered.status === 500) return rendered;
  return { body: { ...body, error: { ...body.error, code: 500, status: 'INTERNAL' } }, status: 500 };
};
