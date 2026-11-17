import { test } from 'vitest';

import { isContextExceededError } from '../../src/shared/context-window-error.ts';
import { assert, assertFalse } from '@floway-dev/test-utils';

test('recognizes context-window error messages', () => {
  assert(isContextExceededError({ message: 'Your input exceeds the context window of this model. Please adjust your input.' }));
  assert(isContextExceededError({ message: "This model's maximum context length is 4097 tokens." }));
  assert(isContextExceededError({ message: 'Request body is too large for model context window' }));
  assertFalse(isContextExceededError({ message: 'a network hiccup' }));
});
