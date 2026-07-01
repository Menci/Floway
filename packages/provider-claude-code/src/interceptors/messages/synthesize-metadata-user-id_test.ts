import { test } from 'vitest';

import { hoistUserSystemToMessages } from './hoist-user-system-to-messages.ts';
import { claudeCodeMessagesChain } from './index.ts';
import { synthesizeMetadataUserId } from './synthesize-metadata-user-id.ts';
import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import { parseMetadataUserID } from '../../detection.ts';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const okEvents = (): Promise<ProviderStreamResult<MessagesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test' });

const invocation = (payload: MessagesPayload, upstreamId = 'up_test'): ClaudeCodeMessagesBoundaryCtx => ({
  payload,
  model: stubProviderModel({ endpoints: { messages: {} } }),
  upstreamId,
});

test('fills metadata.user_id with the new JSON shape when absent', async () => {
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hello' }],
  });

  await synthesizeMetadataUserId(ctx, {}, okEvents);

  const userId = ctx.payload.metadata?.user_id;
  if (typeof userId !== 'string') throw new Error('expected user_id to be a string');
  const parsed = parseMetadataUserID(userId);
  if (!parsed?.isNewFormat) throw new Error(`expected new-format user_id, got ${userId}`);
  assertEquals(parsed.accountUuid, '');
  assertEquals(parsed.deviceId.length, 64);
  // session_id is a UUIDv4 shape: 8-4-4-4-12 hex.
  assertEquals(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed.sessionId), true);
});

test('device_id is stable per upstream id', async () => {
  const a = invocation({ model: 'claude-sonnet-4-5-20250929', max_tokens: 1, messages: [{ role: 'user', content: 'a' }] });
  const b = invocation({ model: 'claude-sonnet-4-5-20250929', max_tokens: 1, messages: [{ role: 'user', content: 'b' }] });
  await synthesizeMetadataUserId(a, {}, okEvents);
  await synthesizeMetadataUserId(b, {}, okEvents);
  const ad = parseMetadataUserID(a.payload.metadata!.user_id!)!;
  const bd = parseMetadataUserID(b.payload.metadata!.user_id!)!;
  assertEquals(ad.deviceId, bd.deviceId);
});

test('device_id differs across upstreams', async () => {
  const a = invocation({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }, 'up_a');
  const b = invocation({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }, 'up_b');
  await synthesizeMetadataUserId(a, {}, okEvents);
  await synthesizeMetadataUserId(b, {}, okEvents);
  const ad = parseMetadataUserID(a.payload.metadata!.user_id!)!;
  const bd = parseMetadataUserID(b.payload.metadata!.user_id!)!;
  if (ad.deviceId === bd.deviceId) throw new Error('expected different device ids per upstream');
});

test('session_id is stable for same upstream + same first-user prefix', async () => {
  const a = invocation({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'prefix' }, { role: 'assistant', content: 'reply1' }] });
  const b = invocation({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'prefix' }, { role: 'assistant', content: 'reply2' }] });
  await synthesizeMetadataUserId(a, {}, okEvents);
  await synthesizeMetadataUserId(b, {}, okEvents);
  const ad = parseMetadataUserID(a.payload.metadata!.user_id!)!;
  const bd = parseMetadataUserID(b.payload.metadata!.user_id!)!;
  assertEquals(ad.sessionId, bd.sessionId);
});

test('preserves a caller-supplied user_id verbatim', async () => {
  const explicit = JSON.stringify({ device_id: 'a'.repeat(32), account_uuid: 'org', session_id: 'sess-1' });
  const ctx = invocation({
    model: 'm',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'x' }],
    metadata: { user_id: explicit },
  });
  await synthesizeMetadataUserId(ctx, {}, okEvents);
  assertEquals(ctx.payload.metadata?.user_id, explicit);
});

// Regression: synthesize must run BEFORE hoist in the chain, otherwise hoist's
// synthetic `<system>\n${captured}\n</system>` becomes the "first user message"
// the session id derives from — and two unrelated conversations sharing one
// operator system prompt collapse onto the same session_id, breaking prompt
// cache routing and rate-limit accounting.
test('session_id differs when system prompt is shared but user message differs (chain order)', async () => {
  const sharedSystem = 'You are a careful research assistant. Always cite sources.';
  const a = invocation({
    model: 'm',
    max_tokens: 1,
    system: sharedSystem,
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
  });
  const b = invocation({
    model: 'm',
    max_tokens: 1,
    system: sharedSystem,
    messages: [{ role: 'user', content: 'Who wrote The Great Gatsby?' }],
  });

  // Drive the same step pair the production chain does: synthesize first,
  // then hoist. Synthesize sees the operator's real first user message;
  // hoist runs after and rewrites `messages` for the wire shape.
  await synthesizeMetadataUserId(a, {}, () => hoistUserSystemToMessages(a, {}, okEvents));
  await synthesizeMetadataUserId(b, {}, () => hoistUserSystemToMessages(b, {}, okEvents));

  const ad = parseMetadataUserID(a.payload.metadata!.user_id!)!;
  const bd = parseMetadataUserID(b.payload.metadata!.user_id!)!;
  if (ad.sessionId === bd.sessionId) {
    throw new Error('expected different session_ids for distinct user prompts sharing a system prompt');
  }
});

test('chain registers synthesize before hoist', () => {
  const chain = claudeCodeMessagesChain();
  const synthIdx = chain.indexOf(synthesizeMetadataUserId);
  const hoistIdx = chain.indexOf(hoistUserSystemToMessages);
  if (synthIdx === -1 || hoistIdx === -1) throw new Error('chain missing required step');
  if (synthIdx >= hoistIdx) throw new Error(`synthesize (${synthIdx}) must run before hoist (${hoistIdx}) so session_id derives from the real user message`);
});
