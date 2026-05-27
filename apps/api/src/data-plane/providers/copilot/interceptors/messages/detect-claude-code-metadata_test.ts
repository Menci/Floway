import { test } from 'vitest';

import { parseUserIdMetadata } from './detect-claude-code-metadata.ts';
import { assertEquals } from '../../../../../test-assert.ts';

test('parseUserIdMetadata returns nulls for undefined input', () => {
  assertEquals(parseUserIdMetadata(undefined), { safetyIdentifier: null, sessionId: null });
});

test('parseUserIdMetadata returns nulls for an empty string', () => {
  assertEquals(parseUserIdMetadata(''), { safetyIdentifier: null, sessionId: null });
});

test('parseUserIdMetadata extracts both halves from the legacy textual form', () => {
  // The legacy form Claude Code historically sent: a single string carrying
  // the safety identifier and session id joined by underscores.
  assertEquals(parseUserIdMetadata('user_acct-abc_account__session_sess-xyz'), {
    safetyIdentifier: 'acct-abc',
    sessionId: 'sess-xyz',
  });
});

test('parseUserIdMetadata reads device_id and session_id from a JSON payload', () => {
  const userId = JSON.stringify({ device_id: 'dev-1', session_id: 'sess-2' });
  assertEquals(parseUserIdMetadata(userId), { safetyIdentifier: 'dev-1', sessionId: 'sess-2' });
});

test('parseUserIdMetadata falls back to account_uuid when device_id is missing', () => {
  const userId = JSON.stringify({ account_uuid: 'acct-2', session_id: 'sess-3' });
  assertEquals(parseUserIdMetadata(userId), { safetyIdentifier: 'acct-2', sessionId: 'sess-3' });
});

test('parseUserIdMetadata yields sessionId only when JSON omits the identifier fields', () => {
  const userId = JSON.stringify({ session_id: 'sess-only' });
  assertEquals(parseUserIdMetadata(userId), { safetyIdentifier: null, sessionId: 'sess-only' });
});

test('parseUserIdMetadata returns nulls for malformed JSON without legacy markers', () => {
  assertEquals(parseUserIdMetadata('not-json-and-no-markers'), { safetyIdentifier: null, sessionId: null });
});
