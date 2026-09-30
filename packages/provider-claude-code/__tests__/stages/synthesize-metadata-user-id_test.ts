import { parse, validate, version } from 'uuid';
import { test } from 'vitest';

import { parseMetadataUserID } from '../../src/detection.ts';
import { hoistUserSystemToMessages } from '../../src/stages/hoist-user-system-to-messages.ts';
import { synthesizeMetadataUserId } from '../../src/stages/synthesize-metadata-user-id.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderStreamResult } from '@floway-dev/provider';
import type { AnthropicMessagesProbe } from '@floway-dev/test-utils';
import { applyProviderStage, assertEquals, stubProviderModel } from '@floway-dev/test-utils';

type ClaudeCodeStageProbe = AnthropicMessagesProbe & { upstreamId: string };

const okEvents = (): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test' });

const invocation = (payload: AnthropicMessagesPayload, upstreamId = 'up_test'): ClaudeCodeStageProbe => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
  upstreamId,
});

test('fills metadata.user_id with the new JSON shape when absent', async () => {
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hello' }],
  });

  await applyProviderStage(synthesizeMetadataUserId(ctx.upstreamId), ctx, okEvents, { 'request.claudeCode.shaped': false });

  const userId = ctx.payload.metadata?.user_id;
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

test('device_id is stable per upstream id', async () => {
  const a = invocation({ model: 'claude-sonnet-4-5-20250929', max_tokens: 1, messages: [{ role: 'user', content: 'a' }] });
  const b = invocation({ model: 'claude-sonnet-4-5-20250929', max_tokens: 1, messages: [{ role: 'user', content: 'b' }] });
  await applyProviderStage(synthesizeMetadataUserId(a.upstreamId), a, okEvents, { 'request.claudeCode.shaped': false });
  await applyProviderStage(synthesizeMetadataUserId(b.upstreamId), b, okEvents, { 'request.claudeCode.shaped': false });
  const ad = parseMetadataUserID(a.payload.metadata!.user_id!)!;
  const bd = parseMetadataUserID(b.payload.metadata!.user_id!)!;
  assertEquals(ad.deviceId, bd.deviceId);
});

test('device_id differs across upstreams', async () => {
  const a = invocation({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }, 'up_a');
  const b = invocation({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }, 'up_b');
  await applyProviderStage(synthesizeMetadataUserId(a.upstreamId), a, okEvents, { 'request.claudeCode.shaped': false });
  await applyProviderStage(synthesizeMetadataUserId(b.upstreamId), b, okEvents, { 'request.claudeCode.shaped': false });
  const ad = parseMetadataUserID(a.payload.metadata!.user_id!)!;
  const bd = parseMetadataUserID(b.payload.metadata!.user_id!)!;
  if (ad.deviceId === bd.deviceId) throw new Error('expected different device ids per upstream');
});

test('session_id is stable for same upstream + same first-user prefix', async () => {
  const a = invocation({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'prefix' }, { role: 'assistant', content: 'reply1' }] });
  const b = invocation({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'prefix' }, { role: 'assistant', content: 'reply2' }] });
  await applyProviderStage(synthesizeMetadataUserId(a.upstreamId), a, okEvents, { 'request.claudeCode.shaped': false });
  await applyProviderStage(synthesizeMetadataUserId(b.upstreamId), b, okEvents, { 'request.claudeCode.shaped': false });
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
  await applyProviderStage(synthesizeMetadataUserId(ctx.upstreamId), ctx, okEvents, { 'request.claudeCode.shaped': false });
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
  await applyProviderStage(synthesizeMetadataUserId(a.upstreamId), a, okEvents, { 'request.claudeCode.shaped': false });
  await applyProviderStage(hoistUserSystemToMessages, a, okEvents, { 'request.claudeCode.shaped': false });
  await applyProviderStage(synthesizeMetadataUserId(b.upstreamId), b, okEvents, { 'request.claudeCode.shaped': false });
  await applyProviderStage(hoistUserSystemToMessages, b, okEvents, { 'request.claudeCode.shaped': false });

  const ad = parseMetadataUserID(a.payload.metadata!.user_id!)!;
  const bd = parseMetadataUserID(b.payload.metadata!.user_id!)!;
  if (ad.sessionId === bd.sessionId) {
    throw new Error('expected different session_ids for distinct user prompts sharing a system prompt');
  }
});
