import { describe, expect, test } from 'vitest';

import {
  buildBillingBlock,
  computeCcVersionFingerprint,
  DEFAULT_TEMPLATE_BLOCK,
  IDENTITY_BLOCK,
} from '../../../src/interceptors/messages/system-blocks.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';

const minimalBody = (firstUserText: string): MessagesPayload => ({
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
  test('is a text block with an ephemeral cache breakpoint', () => {
    expect(DEFAULT_TEMPLATE_BLOCK.type).toBe('text');
    expect(DEFAULT_TEMPLATE_BLOCK.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  test('opens with the interactive-agent introduction line', () => {
    expect(DEFAULT_TEMPLATE_BLOCK.text.startsWith('You are an interactive agent that helps users')).toBe(true);
  });

  test('carries the two IMPORTANT: safety lines', () => {
    expect(DEFAULT_TEMPLATE_BLOCK.text).toContain('IMPORTANT: Assist with authorized security testing');
    expect(DEFAULT_TEMPLATE_BLOCK.text).toContain('IMPORTANT: You must NEVER generate or guess URLs');
  });

  test('carries the # Tone and style section', () => {
    expect(DEFAULT_TEMPLATE_BLOCK.text).toContain('# Tone and style');
    expect(DEFAULT_TEMPLATE_BLOCK.text).toContain('Only use emojis if the user explicitly requests it');
    expect(DEFAULT_TEMPLATE_BLOCK.text).toContain('file_path:line_number');
    expect(DEFAULT_TEMPLATE_BLOCK.text).toContain('Do not use a colon before tool calls');
  });

  test('drops the CC-agent-action sections that would steer non-CC downstreams', () => {
    expect(DEFAULT_TEMPLATE_BLOCK.text).not.toContain('# System');
    expect(DEFAULT_TEMPLATE_BLOCK.text).not.toContain('# Doing tasks');
    expect(DEFAULT_TEMPLATE_BLOCK.text).not.toContain('# Executing actions with care');
    expect(DEFAULT_TEMPLATE_BLOCK.text).not.toContain('# Using your tools');
    expect(DEFAULT_TEMPLATE_BLOCK.text).not.toContain('TodoWrite');
    expect(DEFAULT_TEMPLATE_BLOCK.text).not.toContain('TaskCreate');
  });

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
    expect(computeCcVersionFingerprint('2.1.181', body)).toBe('1f4');
  });

  test('pads short first-user text with 0x30 and still returns 3 hex chars', () => {
    const body = minimalBody('hi');
    // All three indices fall past end; chars = '000'.
    const fp = computeCcVersionFingerprint('2.1.181', body);
    expect(fp).toBe('2f9');
    expect(fp).toMatch(/^[0-9a-f]{3}$/);
  });

  test('walks past assistant messages to the first user-role text', () => {
    const body: MessagesPayload = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [
        { role: 'user', content: 'hello world this is a test prompt' },
        { role: 'assistant', content: 'ack' },
      ],
    };
    expect(computeCcVersionFingerprint('2.1.181', body)).toBe('1f4');
  });

  test('reads the first text block when content is an array', () => {
    const body: MessagesPayload = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello world this is a test prompt' }] },
      ],
    };
    expect(computeCcVersionFingerprint('2.1.181', body)).toBe('1f4');
  });

  test('returns 3-hex output for an empty first-user message', () => {
    const body: MessagesPayload = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [{ role: 'user', content: '' }],
    };
    const fp = computeCcVersionFingerprint('2.1.181', body);
    expect(fp).toMatch(/^[0-9a-f]{3}$/);
    expect(fp).toBe('2f9'); // same as the all-padding case
  });
});

describe('buildBillingBlock', () => {
  test('produces the byte-exact billing line', () => {
    expect(buildBillingBlock('2.1.181', 'abc')).toEqual({
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2.1.181.abc; cc_entrypoint=cli; cch=00000;',
    });
  });

  test('always carries the cch=00000 literal placeholder', () => {
    const block = buildBillingBlock('2.1.181', '000');
    expect(block.text).toContain('cch=00000;');
  });
});
