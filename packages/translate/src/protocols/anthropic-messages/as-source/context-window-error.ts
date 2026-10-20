import { isContextExceededError } from '../../../shared/context-window-error.ts';
import type { TranslatedApiError } from '../../../types.ts';
import { buildPromptTooLongBody } from '@floway-dev/protocols/anthropic-messages';

const isContextExceededErrorText = (text: string): boolean => {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return parsed !== null && typeof parsed === 'object' && isContextExceededError(parsed.error);
  } catch {
    return isContextExceededError({ message: text });
  }
};

// Shared `TranslateTrip.apiError` implementation for the `anthropic-messages-via-*`
// pairs. Rewrites an upstream context-exceeded body into an Anthropic
// prompt-too-long envelope; passes anything else through unchanged.
export const rewriteContextExceededToPromptTooLong = (upstream: TranslatedApiError): TranslatedApiError | undefined => {
  if (!isContextExceededErrorText(new TextDecoder().decode(upstream.body))) return undefined;
  return {
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: buildPromptTooLongBody(),
  };
};
