import { describe, expect, test } from 'vitest';

import {
  CLAUDE_CLI_VERSION,
  CLAUDE_CODE_HEADERS_HAIKU,
  CLAUDE_CODE_HEADERS_SONNET_OPUS,
  pickClaudeCodeHeaders,
} from '../src/headers.ts';

describe('CLAUDE_CLI_VERSION', () => {
  test('is the pinned 2.1.181 release', () => {
    expect(CLAUDE_CLI_VERSION).toBe('2.1.181');
  });
});

describe('CLAUDE_CODE_HEADERS_SONNET_OPUS', () => {
  test('carries every required mimicry header with the pinned value', () => {
    expect(CLAUDE_CODE_HEADERS_SONNET_OPUS).toMatchObject({
      'User-Agent': 'claude-cli/2.1.181 (external, cli)',
      'x-app': 'cli',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-version': '2023-06-01',
      Accept: 'application/json',
      'X-Stainless-Lang': 'js',
      'X-Stainless-Package-Version': '0.94.0',
      'X-Stainless-OS': 'Linux',
      'X-Stainless-Arch': 'arm64',
      'X-Stainless-Runtime': 'node',
      'X-Stainless-Runtime-Version': 'v24.3.0',
      'X-Stainless-Retry-Count': '0',
      'X-Stainless-Timeout': '600',
      'X-Stainless-Helper-Method': 'stream',
    });
  });

  test('anthropic-beta carries the 8-token curated Sonnet/Opus set', () => {
    const beta = CLAUDE_CODE_HEADERS_SONNET_OPUS['anthropic-beta'];
    expect(beta).toBeDefined();
    const tokens = beta!.split(',');
    expect(tokens).toHaveLength(8);
    expect(tokens).toEqual([
      'claude-code-20250219',
      'oauth-2025-04-20',
      'interleaved-thinking-2025-05-14',
      'prompt-caching-scope-2026-01-05',
      'effort-2025-11-24',
      'context-management-2025-06-27',
      'extended-cache-ttl-2025-04-11',
      'mid-conversation-system-2026-04-07',
    ]);
  });
});

describe('CLAUDE_CODE_HEADERS_HAIKU', () => {
  test('anthropic-beta carries the leaner 3-token Haiku set', () => {
    const beta = CLAUDE_CODE_HEADERS_HAIKU['anthropic-beta'];
    expect(beta).toBeDefined();
    const tokens = beta!.split(',');
    expect(tokens).toHaveLength(3);
    expect(tokens).toEqual([
      'oauth-2025-04-20',
      'claude-code-20250219',
      'fine-grained-tool-streaming-2025-05-14',
    ]);
  });

  test('shares the base mimicry surface with the Sonnet/Opus profile', () => {
    for (const key of ['User-Agent', 'x-app', 'anthropic-version', 'X-Stainless-OS', 'X-Stainless-Package-Version']) {
      expect(CLAUDE_CODE_HEADERS_HAIKU[key]).toBe(CLAUDE_CODE_HEADERS_SONNET_OPUS[key]);
    }
  });
});

describe('pickClaudeCodeHeaders', () => {
  test('returns the Haiku set for a dated Haiku model id', () => {
    expect(pickClaudeCodeHeaders('claude-haiku-4-5-20251001')).toBe(CLAUDE_CODE_HEADERS_HAIKU);
  });

  test('returns the Sonnet/Opus set for Sonnet', () => {
    expect(pickClaudeCodeHeaders('claude-sonnet-4-5-20250929')).toBe(CLAUDE_CODE_HEADERS_SONNET_OPUS);
  });

  test('returns the Sonnet/Opus set for Opus', () => {
    expect(pickClaudeCodeHeaders('claude-opus-4-5-20251101')).toBe(CLAUDE_CODE_HEADERS_SONNET_OPUS);
  });

  test('falls through to the Sonnet/Opus set for unknown model ids', () => {
    expect(pickClaudeCodeHeaders('claude-some-future-id')).toBe(CLAUDE_CODE_HEADERS_SONNET_OPUS);
  });
});
