import { anthropicMessagesDebugError } from './errors.ts';
import { sseHttpPanicPresentation } from '../../shared/http-panic.ts';
import { eventFrame, sseFrame } from '@floway-dev/protocols/common';

export const anthropicMessagesHttpPanicPresentation = sseHttpPanicPresentation(502, anthropicMessagesDebugError, error => {
  const event = anthropicMessagesDebugError(error, 'api_error');
  return { frame: eventFrame(event), wire: sseFrame(JSON.stringify(event), 'error') };
});
