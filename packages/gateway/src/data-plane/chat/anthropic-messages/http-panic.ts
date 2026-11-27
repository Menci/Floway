import { anthropicMessagesDebugError } from './errors.ts';
import { clientFrame } from '../pipeline/encode.ts';
import { chatHttpPanicPresentation } from '../pipeline/http-panic.ts';
import { sseFrame } from '@floway-dev/protocols/common';

export const anthropicMessagesHttpPanicPresentation = chatHttpPanicPresentation(502, anthropicMessagesDebugError, error => {
  const event = anthropicMessagesDebugError(error, 'api_error');
  return clientFrame(event, sseFrame(JSON.stringify(event), 'error'));
});
