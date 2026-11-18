import { describe, expect, test } from 'vitest';

import { isClaudeCodeShapedRequest, parseMetadataUserID } from '../src/detection.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesTextBlockParam } from '@floway-dev/protocols/anthropic-messages';

const validUserIdLegacy
  = 'user_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    + '_account_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    + '_session_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const baseHeaders = (overrides: Record<string, string> = {}): Headers => {
  const init: Record<string, string> = {
    'user-agent': 'claude-cli/2.1.280 (external, cli)',
    'x-app': 'cli',
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
    ...overrides,
  };
  return new Headers(init);
};

const bodyWithSystem = (systemText: string, userId: string = validUserIdLegacy): AnthropicMessagesPayload => ({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hi' }],
  system: [{ type: 'text', text: systemText } satisfies AnthropicMessagesTextBlockParam],
  metadata: { user_id: userId },
});

describe('parseMetadataUserID', () => {
  test('parses the legacy form', () => {
    const parsed = parseMetadataUserID(validUserIdLegacy);
    expect(parsed?.isNewFormat).toBe(false);
    expect(parsed?.accountUuid).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(parsed?.sessionId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  test.each([
    ['legacy without account segment', 'user_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_session_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
    ['malformed JSON', '{not-json'],
    ['JSON missing session_id', JSON.stringify({ device_id: 'd' })],
  ])('rejects %s', (_label, raw) => {
    expect(parseMetadataUserID(raw)).toBeNull();
  });
});

describe('isClaudeCodeShapedRequest — UA gate', () => {
  test('accepts canonical UA', () => {
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders({ 'user-agent': 'claude-cli/2.1.280' }),
      body: bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude."),
    })).toBe(true);
  });

});

describe('isClaudeCodeShapedRequest — short-circuit paths', () => {
  test('only a max_tokens=1 Haiku probe passes without system/metadata', () => {
    const shaped = (model: string, maxTokens: number): boolean => isClaudeCodeShapedRequest({
      headers: baseHeaders(),
      body: { model, max_tokens: maxTokens, messages: [{ role: 'user', content: 'quota' }] },
    });

    expect(shaped('claude-haiku-4-5-20251001', 1)).toBe(true);
    expect(shaped('claude-haiku-4-5-20251001', 2)).toBe(false);
    expect(shaped('claude-sonnet-4-5-20250929', 1)).toBe(false);
    expect(shaped('', 1)).toBe(false);
  });
});

describe('isClaudeCodeShapedRequest — Dice template fallback', () => {
  test.each([
    ['You are an interactive agent that helps users with software engineering tasks.'],
  ])('matches identity template: %s', text => {
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders(),
      body: bodyWithSystem(text),
    })).toBe(true);
  });

});

describe('isClaudeCodeShapedRequest — strict header gate', () => {
  test.each(['x-app'])('rejects missing %s', key => {
    const h = baseHeaders();
    h.delete(key);
    expect(isClaudeCodeShapedRequest({
      headers: h,
      body: bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude."),
    })).toBe(false);
  });
});

describe('isClaudeCodeShapedRequest — metadata.user_id', () => {
  test.each([
    ['random text', 'just-a-random-id'],
  ])('rejects invalid metadata.user_id: %s', (_label, raw) => {
    const body = bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude.");
    body.metadata = { user_id: raw };
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders(),
      body,
    })).toBe(false);
  });
});
