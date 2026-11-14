import { test } from 'vitest';

import { isContextExceededError } from '../../src/shared/context-window-error.ts';
import { assert, assertFalse } from '@floway-dev/test-utils';

test('recognizes context-window error codes', () => {
  assert(isContextExceededError({ code: 'context_length_exceeded' }));
  assert(isContextExceededError({ code: 'model_max_prompt_tokens_exceeded' }));
  assertFalse(isContextExceededError({ code: 'rate_limit_exceeded' }));
  assertFalse(isContextExceededError(undefined));
  assertFalse(isContextExceededError(null));
});

test('recognizes context-window error messages', () => {
  assert(isContextExceededError({ message: 'Your input exceeds the context window of this model. Please adjust your input.' }));
  assert(isContextExceededError({ message: "This model's maximum context length is 4097 tokens." }));
  assert(isContextExceededError({ message: 'Request body is too large for model context window' }));
  assertFalse(isContextExceededError({ message: 'a network hiccup' }));
});
