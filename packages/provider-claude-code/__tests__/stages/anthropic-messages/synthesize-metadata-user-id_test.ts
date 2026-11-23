import { parse, validate, version } from 'uuid';
import { test } from 'vitest';

import { parseMetadataUserID } from '../../../src/detection.ts';
import { hoistUserSystemToMessages } from '../../../src/stages/anthropic-messages/hoist-user-system-to-messages.ts';
import { synthesizeMetadataUserId } from '../../../src/stages/anthropic-messages/synthesize-metadata-user-id.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('fills metadata.user_id with the new JSON shape when absent', () => {
  const payload = synthesizeMetadataUserId({
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

// Regression: synthesize must run BEFORE hoist in the chain, otherwise hoist's
// synthetic `<system>\n${captured}\n</system>` becomes the "first user message"
// the session id derives from — and two unrelated conversations sharing one
// operator system prompt collapse onto the same session_id, breaking prompt
// cache routing and rate-limit accounting.
test('session_id differs when system prompt is shared but user message differs (chain order)', () => {
  const sharedSystem = 'You are a careful research assistant. Always cite sources.';
  const a = hoistUserSystemToMessages(synthesizeMetadataUserId({
    max_tokens: 1,
    system: sharedSystem,
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
  }, 'up_test'));
  const b = hoistUserSystemToMessages(synthesizeMetadataUserId({
    max_tokens: 1,
    system: sharedSystem,
    messages: [{ role: 'user', content: 'Who wrote The Great Gatsby?' }],
  }, 'up_test'));

  const ad = parseMetadataUserID(a.metadata!.user_id!)!;
  const bd = parseMetadataUserID(b.metadata!.user_id!)!;
  if (ad.sessionId === bd.sessionId) {
    throw new Error('expected different session_ids for distinct user prompts sharing a system prompt');
  }
});
