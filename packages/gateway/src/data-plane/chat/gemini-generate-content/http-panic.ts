import { geminiGenerateContentInternalErrorPayload } from './errors.ts';
import { sseHttpPanicPresentation } from '../../shared/http-panic.ts';
import { eventFrame, sseRawFrame } from '@floway-dev/protocols/common';
import { toInternalDebugError } from '@floway-dev/upstream';

const internalError = (error: unknown) => geminiGenerateContentInternalErrorPayload(500, toInternalDebugError(error));

export const geminiGenerateContentHttpPanicPresentation = sseHttpPanicPresentation(500, internalError, error => {
  const event = internalError(error);
  return { frame: eventFrame(event), wire: sseRawFrame(JSON.stringify(event)) };
});
