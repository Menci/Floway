import { geminiGenerateContentInternalErrorPayload, geminiGenerateContentRpcErrorPayload, googleRpcHttpStatusCode } from './errors.ts';
import { forwardHttp } from '../../pipeline/non-chat.ts';
import type { InputErrorDetails } from '../shared/errors.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes, snapshotError } from '@floway-dev/pipeline';

export const geminiInputErrorBody = ({ message, param, code }: InputErrorDetails) => {
  const body = geminiGenerateContentRpcErrorPayload(400, message);
  return param === undefined && code === undefined ? body : {
    error: {
      ...body.error,
      details: [{
        '@type': 'type.googleapis.com/google.protobuf.Struct',
        value: { ...(param === undefined ? {} : { param }), ...(code === undefined ? {} : { code }) },
      }],
    },
  };
};

export const geminiInternalErrorBody = (status: number, error: unknown) =>
  geminiGenerateContentInternalErrorPayload(googleRpcHttpStatusCode(status), snapshotError(error));

export const geminiJsonBody = (http: HttpResponseFacts, body: unknown, status = http.status): HttpResponseFacts => ({
  ...http,
  status,
  statusText: status === http.status ? http.statusText : '',
  headers: [...forwardHttp(http, null).headers.filter(([name]) => name !== 'content-type'), ['content-type', 'application/json']],
  body: Bytes.fromUtf8(JSON.stringify(body)),
});
