import { describe, expect, test } from 'vitest';

import { parseCodexUltraConfigDefault, parseCodexUltraConfigStrict } from './ultra-config.ts';

describe('Codex Ultra config', () => {
  test('defaults to disabled', () => {
    expect(parseCodexUltraConfigDefault()).toEqual({ enabled: false });
  });

  test('parses the enabled switch', () => {
    expect(parseCodexUltraConfigStrict({ enabled: true })).toEqual({ enabled: true });
  });

  test.each([
    null,
    {},
    { enabled: 'yes' },
    { enabled: true, extra: true },
  ])('rejects malformed config %#', value => {
    expect(() => parseCodexUltraConfigStrict(value)).toThrow();
  });
});
