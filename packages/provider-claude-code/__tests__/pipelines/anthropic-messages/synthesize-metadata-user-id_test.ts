import { parse, validate, version } from 'uuid';
import { test } from 'vitest';

import { parseMetadataUserID } from '../../../src/detection.ts';
import { withMetadataUserId } from '../../../src/pipelines/anthropic-messages/synthesize-metadata-user-id.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('fills metadata.user_id with the new JSON shape when absent', () => {
  const payload = withMetadataUserId({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hello' }],
  }, 'up_test');

  const userId = payload.metadata?.user_id;
  if (typeof userId !== 'string') throw new Error('expected user_id to be a string');
  const parsed = parseMetadataUserID(userId);
  if (!parsed?.isNewFormat) throw new Error(`expected new-format user_id, got ${userId}`);
  assertEquals(parsed.accountUuid, '');
  assertEquals(parsed.deviceId.length, 64);
  assertEquals(parsed.sessionId, '80fb0a05-3393-495f-99f1-686f0c95e983');
  assertEquals(validate(parsed.sessionId), true);
  assertEquals(version(parsed.sessionId), 4);
  assertEquals(parse(parsed.sessionId)[8] & 0xc0, 0x80);
});
