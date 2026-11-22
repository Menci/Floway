import { describe, expect, test } from 'vitest';

import { computeCcVersionFingerprint } from '../../../src/stages/anthropic-messages/system-blocks.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

const minimalBody = (firstUserText: string): AnthropicMessagesPayload => ({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{ role: 'user', content: firstUserText }],
});

describe('computeCcVersionFingerprint', () => {
  test('matches the known vector for a long first-user text', () => {
    const body = minimalBody('hello world this is a test prompt');
    // 'hello world this is a test prompt' — bytes[4]='o' (0x6F),
    // bytes[7]='o' (0x6F, second 'o' in "world"), bytes[20]='a' (0x61).
    expect(computeCcVersionFingerprint('2.1.280', body)).toBe('309');
  });

});
