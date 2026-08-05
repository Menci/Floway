import { expect, test } from 'vitest';

import { authoritativeStreamSuffix } from '../../../src/shared/via-responses/authoritative-stream-value.ts';

test('authoritativeStreamSuffix returns only content missing from streamed deltas', () => {
  expect(authoritativeStreamSuffix('{"q":', '{"q":1}', 'function arguments')).toBe('1}');
  expect(authoritativeStreamSuffix('', 'complete', 'text')).toBe('complete');
  expect(authoritativeStreamSuffix('complete', 'complete', 'text')).toBe('');
  expect(authoritativeStreamSuffix('partial', '', 'text')).toBe('');
});

test('authoritativeStreamSuffix rejects a conflicting final value', () => {
  expect(() => authoritativeStreamSuffix('left', 'right', 'text')).toThrowError(
    'Upstream text done value does not extend its streamed deltas.',
  );
});
