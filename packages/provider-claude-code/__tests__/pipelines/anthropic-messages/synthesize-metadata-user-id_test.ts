import { parse, validate, version } from 'uuid';
import { expect, test } from 'vitest';

import { parseMetadataUserID } from '../../../src/detection.ts';
import { addMetadataUserId } from '../../../src/pipelines/anthropic-messages/synthesize-metadata-user-id.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

const payload = {
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hello' }],
} satisfies AnthropicMessagesPayload;

test('synthesizes a deterministic device and UUID v4 session for a request without user_id', () => {
  const { metadata } = addMetadataUserId(payload, 'up_test');
  const userId = metadata!.user_id!;
  const parsed = parseMetadataUserID(userId)!;
  expect(parsed).toMatchObject({ accountUuid: '', isNewFormat: true, sessionId: '80fb0a05-3393-495f-99f1-686f0c95e983' });
  expect(parsed.deviceId).toMatch(/^[a-f0-9]{64}$/);
  expect(validate(parsed.sessionId)).toBe(true);
  expect(version(parsed.sessionId)).toBe(4);
  expect(parse(parsed.sessionId)[8] & 0xc0).toBe(0x80);
});

test('preserves a supplied user_id', () => {
  const withUserId = { ...payload, metadata: { user_id: 'operator-supplied' } };
  expect(addMetadataUserId(withUserId, 'up_test')).toBe(withUserId);
});
