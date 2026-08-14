import { parse, validate, version } from 'uuid';
import { test } from 'vitest';

import { withInteractionIdHeaderSet } from '../../../src/interceptors/messages/set-interaction-id-header.ts';
import type { MessagesBoundaryCtx } from '../../../src/interceptors/messages/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assert, assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload): MessagesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

const payloadWith = (userId: string | undefined): MessagesPayload => ({
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user', content: 'hi' }],
  ...(userId !== undefined ? { metadata: { user_id: userId } } : {}),
});

// Known SHA-256 → UUID v4 vectors, computed once by hand and stored here so
// any drift in the hashing or UUID-formatting logic surfaces as a clear
// regression. Format follows caozhiyuan's `getUUID`:
// https://github.com/caozhiyuan/copilot-api/blob/main/src/lib/utils.ts#L230
const SESS_LEGACY_UUID = 'd24fc06b-7a2c-4623-8a31-6ec796e11db4';
const SESS_JSON_UUID = 'da2e7508-8445-4801-9283-91a8df330635';
const SESS_ALONE_UUID = '19be0c9e-9a65-43eb-be80-efb2770d4510';

test('Interaction-id forwarded as a SHA-256 UUID for the legacy fingerprint with both halves', async () => {
  const ctx = invocation(payloadWith('user_acct-1_account__session_sess-legacy'));

  await withInteractionIdHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-interaction-id'), SESS_LEGACY_UUID);
});

test('Interaction-id forwarded as a SHA-256 UUID for the JSON fingerprint carrying session_id', async () => {
  const ctx = invocation(payloadWith(JSON.stringify({ device_id: 'dev', session_id: 'sess-json' })));

  await withInteractionIdHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-interaction-id'), SESS_JSON_UUID);
});

test('Interaction-id forwarded as a SHA-256 UUID even when only the sessionId half is parseable', async () => {
  // OpenCode-like payloads sometimes ship session_id without a paired
  // device_id / account_uuid; we still want trace correlation in that case.
  const ctx = invocation(payloadWith(JSON.stringify({ session_id: 'sess-alone' })));

  await withInteractionIdHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-interaction-id'), SESS_ALONE_UUID);
});

test('Interaction-id hashing is deterministic across repeated invocations', async () => {
  const first = invocation(payloadWith(JSON.stringify({ session_id: 'sess-alone' })));
  const second = invocation(payloadWith(JSON.stringify({ session_id: 'sess-alone' })));

  await withInteractionIdHeaderSet(first, stubRequest, okEvents);
  await withInteractionIdHeaderSet(second, stubRequest, okEvents);

  assertEquals(first.headers.get('x-interaction-id'), second.headers.get('x-interaction-id'));
});

test('Interaction-id has RFC UUIDv4 version and variant bits', async () => {
  const ctx = invocation(payloadWith(JSON.stringify({ session_id: 'sess-shape-check' })));

  await withInteractionIdHeaderSet(ctx, stubRequest, okEvents);

  const value = ctx.headers.get('x-interaction-id');
  assert(value !== null && validate(value));
  assertEquals(value, 'beaa3c07-13ee-4265-8432-db45acf47d67');
  assertEquals(version(value), 4);
  assertEquals(parse(value)[8] & 0xc0, 0x80);
});

test('Interaction-id absent when metadata.user_id is missing', async () => {
  const ctx = invocation(payloadWith(undefined));

  await withInteractionIdHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('x-interaction-id'), false);
});

test('Interaction-id absent when metadata.user_id carries no session marker', async () => {
  const ctx = invocation(payloadWith('user_acct-1_account'));

  await withInteractionIdHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('x-interaction-id'), false);
});
