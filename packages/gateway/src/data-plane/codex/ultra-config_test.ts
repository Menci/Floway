import { describe, expect, test } from 'vitest';

import { parseCodexUltraConfigDefault, parseCodexUltraConfigStrict } from './ultra-config.ts';

describe('Codex Ultra config', () => {
  test('defaults to disabled with the official max wire effort', () => {
    expect(parseCodexUltraConfigDefault()).toEqual({ enabled: false, redirectEffort: 'max' });
  });

  test('preserves an open-string redirect effort verbatim', () => {
    expect(parseCodexUltraConfigStrict({ enabled: true, redirectEffort: 'future-tier' })).toEqual({
      enabled: true,
      redirectEffort: 'future-tier',
    });
  });

  test.each([
    null,
    {},
    { enabled: 'yes', redirectEffort: 'high' },
    { enabled: true, redirectEffort: '' },
    { enabled: true, redirectEffort: 'high', extra: true },
  ])('rejects malformed config %#', value => {
    expect(() => parseCodexUltraConfigStrict(value)).toThrow();
  });
});
