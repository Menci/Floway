import { geminiGenerateContentInternalErrorPayload } from './errors.ts';
import { clientFrame } from '../pipeline/encode.ts';
import { chatHttpPanicPresentation } from '../pipeline/http-panic.ts';
import { sseRawFrame } from '@floway-dev/protocols/common';
import { toInternalDebugError } from '@floway-dev/upstream';

const internalError = (error: unknown) => geminiGenerateContentInternalErrorPayload(500, toInternalDebugError(error));

export const geminiGenerateContentHttpPanicPresentation = chatHttpPanicPresentation(500, internalError, error => {
  const event = internalError(error);
  return clientFrame(event, sseRawFrame(JSON.stringify(event)));
});
