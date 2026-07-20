import { describe, expect, it } from 'vitest';

import { isCodexUserAgent, parseCodexVersion } from './user-agent.ts';

describe('Codex User-Agent parsing', () => {
  it.each([
    ['codex_cli_rs/0.144.1 (Mac OS 15.5; arm64)', '0.144.1'],
    ['codex_exec/0.144.1 (linux; x86_64)', '0.144.1'],
    ['codex_exec/1.0.52-alpha.1-x+build.7', '1.0.52-alpha.1-x+build.7'],
  ])('recognizes %s', (userAgent, version) => {
    expect(parseCodexVersion(userAgent)).toBe(version);
    expect(isCodexUserAgent(userAgent)).toBe(true);
  });

  it.each([
    undefined,
    'curl/8.7.1',
    'wrapper/1.0 codex_exec/0.144.1',
    'Codex_exec/0.144.1',
    'codex_exec/0.144',
    'codex_exec/0.144.1extra',
  ])('rejects non-Codex identity %s', userAgent => {
    expect(parseCodexVersion(userAgent)).toBeNull();
    expect(isCodexUserAgent(userAgent)).toBe(false);
  });
});
