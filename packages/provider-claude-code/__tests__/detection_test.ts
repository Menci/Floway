import { describe, expect, test } from 'vitest';

import { isClaudeCodeShapedRequest, parseMetadataUserID } from '../src/detection.ts';
import type { MessagesPayload, MessagesTextBlock } from '@floway-dev/protocols/messages';

const validUserIdLegacy
  = 'user_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    + '_account_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    + '_session_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const validUserIdJson = JSON.stringify({
  device_id: 'dev-1234',
  account_uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  session_id: 'sess-9876',
});

const baseHeaders = (overrides: Record<string, string> = {}): Headers => {
  const init: Record<string, string> = {
    'user-agent': 'claude-cli/2.1.181 (external, cli)',
    'x-app': 'cli',
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
    ...overrides,
  };
  return new Headers(init);
};

const bodyWithSystem = (systemText: string, userId: string = validUserIdLegacy): MessagesPayload => ({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hi' }],
  system: [{ type: 'text', text: systemText } satisfies MessagesTextBlock],
  metadata: { user_id: userId },
});

describe('parseMetadataUserID', () => {
  test('parses the legacy form', () => {
    const parsed = parseMetadataUserID(validUserIdLegacy);
    expect(parsed).not.toBeNull();
    expect(parsed?.isNewFormat).toBe(false);
    expect(parsed?.accountUuid).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(parsed?.sessionId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  test('parses the new JSON form', () => {
    const parsed = parseMetadataUserID(validUserIdJson);
    expect(parsed).not.toBeNull();
    expect(parsed?.isNewFormat).toBe(true);
    expect(parsed?.deviceId).toBe('dev-1234');
    expect(parsed?.sessionId).toBe('sess-9876');
  });

  test('accepts empty account_uuid in JSON form', () => {
    const parsed = parseMetadataUserID(JSON.stringify({ device_id: 'dev', account_uuid: '', session_id: 'sess' }));
    expect(parsed?.accountUuid).toBe('');
  });

  test.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['legacy with bad session uuid', 'user_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_account_x_session_short'],
    ['legacy without account segment', 'user_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_session_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
    ['malformed JSON', '{not-json'],
    ['JSON missing device_id', JSON.stringify({ session_id: 's' })],
    ['JSON missing session_id', JSON.stringify({ device_id: 'd' })],
  ])('rejects %s', (_label, raw) => {
    expect(parseMetadataUserID(raw)).toBeNull();
  });
});

describe('isClaudeCodeShapedRequest — UA gate', () => {
  test('accepts canonical UA', () => {
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders({ 'user-agent': 'claude-cli/2.1.181' }),
      body: bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude."),
    })).toBe(true);
  });

  test('accepts older CC UA', () => {
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders({ 'user-agent': 'claude-cli/2.1.10' }),
      body: bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude."),
    })).toBe(true);
  });

  test('rejects UA missing patch version', () => {
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders({ 'user-agent': 'claude-cli/2.1' }),
      body: bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude."),
    })).toBe(false);
  });

  test('rejects non-prefix UA', () => {
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders({ 'user-agent': 'not-claude-cli/2.1.10' }),
      body: bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude."),
    })).toBe(false);
  });

  test('rejects bare claude-cli/ UA', () => {
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders({ 'user-agent': 'claude-cli/' }),
      body: bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude."),
    })).toBe(false);
  });

  test('rejects missing UA', () => {
    const h = baseHeaders();
    h.delete('user-agent');
    expect(isClaudeCodeShapedRequest({
      headers: h,
      body: bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude."),
    })).toBe(false);
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

describe('isClaudeCodeShapedRequest — billing-block fast path', () => {
  test('accepts a request whose first system block is the billing header', () => {
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders(),
      body: bodyWithSystem('x-anthropic-billing-header: cc_version=2.1.181.abc; cc_entrypoint=cli; cch=00000;'),
    })).toBe(true);
  });

  test('rejects a billing-like header missing cc_entrypoint=cli', () => {
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders(),
      body: bodyWithSystem('x-anthropic-billing-header: cc_version=2.1.181.abc; some_other_marker=1;'),
    })).toBe(false);
  });
});

describe('isClaudeCodeShapedRequest — Dice template fallback', () => {
  test.each([
    ["You are Claude Code, Anthropic's official CLI for Claude."],
    ["You are a Claude agent, built on Anthropic's Claude Agent SDK."],
    ["You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."],
    ["You are a file search specialist for Claude Code, Anthropic's official CLI for Claude."],
    ['You are a helpful AI assistant tasked with summarizing conversations.'],
    ['You are an interactive CLI tool that helps users with software engineering tasks.'],
    ['You are an interactive agent that helps users with software engineering tasks.'],
  ])('matches identity template: %s', text => {
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders(),
      body: bodyWithSystem(text),
    })).toBe(true);
  });

  test('rejects a non-CC system prompt that does not Dice-match any template', () => {
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders(),
      body: bodyWithSystem('Translate the following passage into French and preserve the original meter.'),
    })).toBe(false);
  });
});

describe('isClaudeCodeShapedRequest — strict header gate', () => {
  test.each(['x-app', 'anthropic-beta', 'anthropic-version'])('rejects missing %s', key => {
    const h = baseHeaders();
    h.delete(key);
    expect(isClaudeCodeShapedRequest({
      headers: h,
      body: bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude."),
    })).toBe(false);
  });
});

describe('isClaudeCodeShapedRequest — metadata.user_id', () => {
  test('accepts legacy form', () => {
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders(),
      body: bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude.", validUserIdLegacy),
    })).toBe(true);
  });

  test('accepts JSON form', () => {
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders(),
      body: bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude.", validUserIdJson),
    })).toBe(true);
  });

  test.each([
    ['empty string', ''],
    ['random text', 'just-a-random-id'],
    ['malformed JSON', '{not-json'],
  ])('rejects invalid metadata.user_id: %s', (_label, raw) => {
    const body = bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude.");
    body.metadata = { user_id: raw };
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders(),
      body,
    })).toBe(false);
  });

  test('rejects when metadata is absent entirely', () => {
    const body = bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude.");
    delete body.metadata;
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders(),
      body,
    })).toBe(false);
  });
});

describe('isClaudeCodeShapedRequest — system shape variants', () => {
  test('accepts a system string when its content matches an identity template', () => {
    const body: MessagesPayload = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      metadata: { user_id: validUserIdLegacy },
    };
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders(),
      body,
    })).toBe(true);
  });

  test('rejects an empty system block', () => {
    const body = bodyWithSystem("You are Claude Code, Anthropic's official CLI for Claude.");
    body.system = [];
    expect(isClaudeCodeShapedRequest({
      headers: baseHeaders(),
      body,
    })).toBe(false);
  });
});
