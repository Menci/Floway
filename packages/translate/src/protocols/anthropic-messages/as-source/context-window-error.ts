import { isContextExceededError } from '../../../shared/context-window-error.ts';
import type { ApiErrorTranslator } from '../../../types.ts';
import { PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';

const isContextExceededErrorText = (text: string): boolean => {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return parsed !== null && typeof parsed === 'object' && isContextExceededError(parsed.error);
  } catch {
    return isContextExceededError({ message: text });
  }
};

// Shared `TranslateTrip.error` implementation for the `anthropic-messages-via-*`
// pairs. Rewrites an upstream context-exceeded body into an Anthropic
// prompt-too-long envelope; passes anything else through unchanged.
export const rewriteContextExceededToPromptTooLong: ApiErrorTranslator = (_status, _headers, body) => {
  if (!isContextExceededErrorText(new TextDecoder().decode(body))) return undefined;
  return {
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: { type: 'error', error: { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE } },
  };
};
