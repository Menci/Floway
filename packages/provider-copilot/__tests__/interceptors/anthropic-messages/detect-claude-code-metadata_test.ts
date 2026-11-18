import { test } from 'vitest';

import { parseUserIdMetadata } from '../../../src/interceptors/anthropic-messages/detect-claude-code-metadata.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('parseUserIdMetadata extracts both halves from the legacy textual form', () => {
  // The legacy form Claude Code historically sent: a single string carrying
  // the safety identifier and session id joined by underscores.
  assertEquals(parseUserIdMetadata('user_acct-abc_account__session_sess-xyz'), {
    safetyIdentifier: 'acct-abc',
    sessionId: 'sess-xyz',
  });
});

test('parseUserIdMetadata falls back to account_uuid when device_id is missing', () => {
  const userId = JSON.stringify({ account_uuid: 'acct-2', session_id: 'sess-3' });
  assertEquals(parseUserIdMetadata(userId), { safetyIdentifier: 'acct-2', sessionId: 'sess-3' });
});
