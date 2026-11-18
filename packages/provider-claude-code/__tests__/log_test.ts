import { afterEach, describe, expect, test, vi } from 'vitest';

import { logInfo } from '../src/log.ts';

afterEach(() => vi.restoreAllMocks());

describe('log helpers', () => {
  test('quotes strings carrying whitespace, equals, or quote chars', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logInfo('claude_code_test_event', {
      message: 'token revoked by upstream',
      key_eq: 'a=b',
      contains_quote: 'say "hi"',
    });
    expect(spy).toHaveBeenCalledExactlyOnceWith(
      'claude_code_test_event message="token revoked by upstream" key_eq="a=b" contains_quote="say \\"hi\\""',
    );
  });
});
