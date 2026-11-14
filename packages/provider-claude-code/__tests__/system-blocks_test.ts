import { describe, expect, test } from 'vitest';

import {
  buildBillingBlock,
  computeCcVersionFingerprint,
  DEFAULT_TEMPLATE_BLOCK,
  IDENTITY_BLOCK,
} from '../src/system-blocks.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

const minimalBody = (firstUserText: string): AnthropicMessagesPayload => ({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{ role: 'user', content: firstUserText }],
});

describe('IDENTITY_BLOCK', () => {
  test('is a text block with the byte-exact identity string', () => {
    expect(IDENTITY_BLOCK).toEqual({
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    });
  });
});

describe('DEFAULT_TEMPLATE_BLOCK', () => {
  test('stays in the trimmed-subset size range', () => {
    expect(DEFAULT_TEMPLATE_BLOCK.text.length).toBeGreaterThan(1000);
    expect(DEFAULT_TEMPLATE_BLOCK.text.length).toBeLessThan(3000);
  });
});

describe('computeCcVersionFingerprint', () => {
  test('matches the known vector for a long first-user text', () => {
    const body = minimalBody('hello world this is a test prompt');
    // 'hello world this is a test prompt' — bytes[4]='o' (0x6F),
    // bytes[7]='o' (0x6F, second 'o' in "world"), bytes[20]='a' (0x61).
    expect(computeCcVersionFingerprint('2.1.280', body)).toBe('309');
  });

  test('pads short first-user text with 0x30 and still returns 3 hex chars', () => {
    const body = minimalBody('hi');
    // All three indices fall past end; chars = '000'.
    const fp = computeCcVersionFingerprint('2.1.280', body);
    expect(fp).toBe('d7b');
    expect(fp).toMatch(/^[0-9a-f]{3}$/);
  });

  test('walks past assistant messages to the first user-role text', () => {
    const body: AnthropicMessagesPayload = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [
        { role: 'user', content: 'hello world this is a test prompt' },
        { role: 'assistant', content: 'ack' },
      ],
    };
    expect(computeCcVersionFingerprint('2.1.280', body)).toBe('309');
  });

  test('reads the first text block when content is an array', () => {
    const body: AnthropicMessagesPayload = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello world this is a test prompt' }] },
      ],
    };
    expect(computeCcVersionFingerprint('2.1.280', body)).toBe('309');
  });

  test('returns 3-hex output for an empty first-user message', () => {
    const body: AnthropicMessagesPayload = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [{ role: 'user', content: '' }],
    };
    const fp = computeCcVersionFingerprint('2.1.280', body);
    expect(fp).toMatch(/^[0-9a-f]{3}$/);
    expect(fp).toBe('d7b'); // same as the all-padding case
  });
});

describe('buildBillingBlock', () => {
  test('produces the byte-exact billing line', () => {
    expect(buildBillingBlock('2.1.280', 'abc')).toEqual({
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2.1.280.abc; cc_entrypoint=cli; cch=00000;',
    });
  });
});
