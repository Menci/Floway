import { afterEach, describe, expect, test, vi } from 'vitest';

import { logInfo, logWarn } from '../src/log.ts';

afterEach(() => vi.restoreAllMocks());

describe('log helpers', () => {
  test('formats bare event with no fields', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logInfo('claude_code_test_event');
    expect(spy).toHaveBeenCalledExactlyOnceWith('claude_code_test_event');
  });

  test('emits bare values for safe strings, numbers, booleans', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logInfo('claude_code_test_event', {
      upstream_id: 'up_abc123',
      attempt: 3,
      ok: true,
      done: false,
    });
    expect(spy).toHaveBeenCalledExactlyOnceWith(
      'claude_code_test_event upstream_id=up_abc123 attempt=3 ok=true done=false',
    );
  });

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

  test('renders null and undefined as the literal "null"', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logInfo('claude_code_test_event', {
      reset_at_iso: null,
      reason: undefined,
    });
    expect(spy).toHaveBeenCalledExactlyOnceWith(
      'claude_code_test_event reset_at_iso=null reason=null',
    );
  });

  test('quotes empty strings so they remain visible in the line', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logInfo('claude_code_test_event', { value: '' });
    expect(spy).toHaveBeenCalledExactlyOnceWith('claude_code_test_event value=""');
  });

  test('logWarn routes through console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logWarn('claude_code_test_event', { upstream_id: 'up_x' });
    expect(spy).toHaveBeenCalledExactlyOnceWith('claude_code_test_event upstream_id=up_x');
  });
});
