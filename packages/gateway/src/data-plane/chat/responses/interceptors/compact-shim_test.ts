import { test } from 'vitest';

import { expandShimCompactionItems, withResponsesCompactShim } from './compact-shim.ts';
import type { ResponsesInvocation } from './types.ts';
import { encodeBase64UrlJson } from '../../../../shared/base64url-json.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import { createNonResponsesSourceStore } from '../items/store.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectResponsesProtocolEventsToResult, type ResponsesPayload, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { eventResult, type ExecuteResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

const stubCtx: ChatGatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore('test-key'),
};

const makeInvocation = (
  payload: Partial<ResponsesPayload> = {},
  options: { action?: 'generate' | 'compact'; flagOn?: boolean; targetApi?: 'responses' | 'messages' | 'chat-completions' } = {},
): ResponsesInvocation => ({
  payload: { model: 'test-model', input: [], ...payload } as CanonicalResponsesPayload,
  action: options.action ?? 'generate',
  candidate: stubModelCandidate({ enabledFlags: new Set(options.flagOn === false ? [] : ['responses-compact-shim']) }),
  targetApi: options.targetApi ?? 'responses',
  headers: new Headers(),
});

// Build a fake upstream `run()` that emits a single completed response whose
// output contains one assistant message with the given text. Used to model
// the inner summarization turn the shim drives.
const fakeUpstreamRun = (summaryText: string): () => Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  const response: ResponsesResult = {
    id: 'resp_fake_upstream',
    object: 'response',
    model: 'test-upstream-model',
    status: 'completed',
    output: [{
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: summaryText }],
    }],
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  };
  return () => Promise.resolve(eventResult(
    (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.completed', sequence_number: 0, response });
      yield doneFrame();
    })(),
    testTelemetryModelIdentity,
  ));
};

// ── Inbound expansion (expandShimCompactionItems) ────────────────────────────

test('inbound: compaction item with a shim-encoded payload expands inline', () => {
  const userItem = { type: 'message' as const, role: 'user' as const, content: 'history one' };
  const encoded = encodeBase64UrlJson([userItem]);

  const expanded = expandShimCompactionItems({
    model: 'm',
    input: [
      { type: 'compaction', id: 'cmp_1', encrypted_content: encoded } as unknown as never,
      { type: 'message', role: 'user', content: 'new turn' },
    ],
  });

  assertEquals(expanded.input.length, 2);
  assertEquals(expanded.input[0], userItem);
  assertEquals(expanded.input[1], { type: 'message', role: 'user', content: 'new turn' });
});

test('inbound: foreign compaction blob (non-base64url-JSON) round-trips untouched', () => {
  const original = {
    model: 'm',
    input: [
      { type: 'compaction', id: 'cmp_native', encrypted_content: 'OPAQUE_NATIVE_BLOB' } as unknown as never,
    ],
  };
  const expanded = expandShimCompactionItems(original);
  // No items expanded — the foreign blob fails decode and the item passes
  // through as-is.
  assertEquals(expanded, original);
});

test('inbound: foreign compaction blob (valid base64url but wrong shape) round-trips untouched', () => {
  // base64url-encoded JSON of an object (not an array) — decode succeeds,
  // but the schema check rejects it.
  const wrongShape = encodeBase64UrlJson({ not: 'an array' });
  const original = {
    model: 'm',
    input: [
      { type: 'compaction', id: 'cmp_foreign', encrypted_content: wrongShape } as unknown as never,
    ],
  };
  const expanded = expandShimCompactionItems(original);
  assertEquals(expanded, original);
});

// ── Outbound summarization (withResponsesCompactShim) ────────────────────────

test('compact + flag on: pivots to generate, drives upstream summarization, returns compaction envelope', async () => {
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'long conversation history' }] },
    { action: 'compact' },
  );

  let seenPayload: ResponsesPayload | undefined;
  let seenAction: 'generate' | 'compact' | undefined;
  const result = await withResponsesCompactShim(inv, stubCtx, () => {
    seenPayload = inv.payload;
    seenAction = inv.action;
    return fakeUpstreamRun('CONDENSED SUMMARY')();
  });

  if (result.type !== 'events') throw new Error(`expected events branch, got ${result.type}`);
  // Inner action seen by the upstream is 'generate'.
  assertEquals(seenAction, 'generate');
  // The pivot is one-way per the project's interceptor convention: outer
  // ctx.action stays 'generate' after the run. attempt.invoke keys
  // envelope-drain on the caller's intent action (captured by value), so
  // leaving invocation.action='generate' does not change the result shape.
  assertEquals(inv.action, 'generate');
  // Payload pivoted: SUMMARIZATION_PROMPT injected, store:false, the
  // original history retained (compaction_trigger items would be stripped
  // but there are none here).
  if (!seenPayload) throw new Error('expected the upstream call to see the rewritten payload');
  assertEquals(typeof seenPayload.instructions, 'string');
  assertEquals((seenPayload.instructions as string).includes('CONTEXT CHECKPOINT COMPACTION'), true);
  assertEquals(seenPayload.store, false);

  const collected = await collectResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.object, 'response.compaction');
  const compactionItem = collected.output[0] as { type: string; encrypted_content: string };
  assertEquals(compactionItem.type, 'compaction');
});

test('compact + flag on: synthesized encrypted_content decodes to a user message containing the summary', async () => {
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'history' }] },
    { action: 'compact' },
  );
  const result = await withResponsesCompactShim(inv, stubCtx, fakeUpstreamRun('THE SUMMARY'));
  if (result.type !== 'events') throw new Error('expected events branch');
  const collected = await collectResponsesProtocolEventsToResult(result.events);
  const compactionItem = collected.output[0] as { type: string; encrypted_content: string };

  // The encrypted_content decodes to our base64url-JSON marker: one
  // user-role message carrying the summary as input_text.
  const decoded = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob(compactionItem.encrypted_content.replace(/-/g, '+').replace(/_/g, '/')),
        c => c.charCodeAt(0),
      ),
    ),
  );
  assertEquals(decoded.length, 1);
  assertEquals(decoded[0].type, 'message');
  assertEquals(decoded[0].role, 'user');
  assertEquals(decoded[0].content[0].type, 'input_text');
  assertEquals(decoded[0].content[0].text, 'THE SUMMARY');
});

test('compact + flag on: synthesized compaction id is registered as synthetic so storage drops upstream affinity', async () => {
  // The minted `cmp_<uuid>` is gateway-internal — no upstream issued it.
  // wrapResponsesOutputForStorage keys upstreamOwned on
  // `targetApi === 'responses' && !store.isSyntheticItem(upstreamId)`; without
  // the synthetic registration, a flag-on engagement against a responses
  // target would store the row with the originating upstreamId set, and
  // classifyStoredResponsesAffinity would lock routing to that upstream
  // on any later turn that echoes the compaction.
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'history' }] },
    { action: 'compact' },
  );
  const result = await withResponsesCompactShim(inv, stubCtx, fakeUpstreamRun('summary'));
  if (result.type !== 'events') throw new Error('expected events branch');
  const collected = await collectResponsesProtocolEventsToResult(result.events);
  const compactionItem = collected.output[0] as { type: string; id: string };
  assertEquals(stubCtx.store.isSyntheticItem(compactionItem.id), true);
});

test('compact + flag on: upstream `output_text` SDK alias is dropped from the synthesized envelope', async () => {
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'history' }] },
    { action: 'compact' },
  );

  // Some upstreams (and some OpenAPI implementations) emit the convenience
  // `output_text` alias alongside `output`. The synthesized
  // `response.compaction` envelope must not forward it — its value is the
  // upstream's summary plaintext, which a downstream SDK reading
  // `output_text` on a compaction envelope would surface in place of the
  // opaque-blob contract `encrypted_content` is supposed to carry.
  const runWithOutputText = (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const response: ResponsesResult = {
      id: 'resp_fake_upstream',
      object: 'response',
      model: 'test-upstream-model',
      status: 'completed',
      output: [{
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'THE SUMMARY' }],
      }],
      output_text: 'THE SUMMARY',
      error: null,
      incomplete_details: null,
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    };
    return Promise.resolve(eventResult(
      (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
        yield eventFrame({ type: 'response.completed', sequence_number: 0, response });
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ));
  };
  const result = await withResponsesCompactShim(inv, stubCtx, runWithOutputText);
  if (result.type !== 'events') throw new Error('expected events branch');
  const collected = await collectResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.output_text, undefined);
});

test('compact + flag on: upstream incomplete status propagates onto the synthesized envelope', async () => {
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'history' }] },
    { action: 'compact' },
  );

  // Simulate a summarization turn that hit `max_output_tokens` mid-stream:
  // the upstream returns `status: 'incomplete'` with `incomplete_details`
  // populated. The synthesized envelope must surface that — not pretend the
  // turn ran to completion.
  const runIncomplete = (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const response: ResponsesResult = {
      id: 'resp_fake_upstream',
      object: 'response',
      model: 'test-upstream-model',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'incomplete',
        content: [{ type: 'output_text', text: 'partial summary' }],
      }],
      error: null,
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    };
    return Promise.resolve(eventResult(
      (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
        yield eventFrame({ type: 'response.completed', sequence_number: 0, response });
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ));
  };
  const result = await withResponsesCompactShim(inv, stubCtx, runIncomplete);
  if (result.type !== 'events') throw new Error('expected events branch');
  const collected = await collectResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.status, 'incomplete');
  assertEquals(collected.incomplete_details, { reason: 'max_output_tokens' });
});

test('compact + flag on: compaction_trigger items are stripped before the upstream call', async () => {
  const inv = makeInvocation(
    {
      input: [
        { type: 'message', role: 'user', content: 'real history' },
        { type: 'compaction_trigger' } as unknown as never,
      ],
    },
    { action: 'compact' },
  );

  let seenPayload: ResponsesPayload | undefined;
  await withResponsesCompactShim(inv, stubCtx, () => {
    seenPayload = inv.payload;
    return fakeUpstreamRun('s')();
  });
  if (!seenPayload) throw new Error('expected the upstream call to fire');
  const items = seenPayload.input as Array<{ type: string }>;
  assertEquals(items.every(i => i.type !== 'compaction_trigger'), true);
});

test('compact + flag on: history ending on an assistant message gets a synthetic terminal user prompt appended', async () => {
  // Anthropic Messages rejects assistant prefill: a conversation that
  // ends on an assistant turn returns 400 `This model does not support
  // assistant message prefill`. The shim normalizes by appending a
  // synthetic user-role nudge so the summarization call always ends on
  // a user message — harmless on OpenAI-style upstreams and load-bearing
  // for translated Anthropic ones.
  const inv = makeInvocation(
    {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello back' }] } as unknown as never,
      ],
    },
    { action: 'compact' },
  );

  let seenPayload: ResponsesPayload | undefined;
  await withResponsesCompactShim(inv, stubCtx, () => {
    seenPayload = inv.payload;
    return fakeUpstreamRun('s')();
  });
  if (!seenPayload) throw new Error('expected the upstream call to fire');
  const items = seenPayload.input as Array<{ type: string; role?: string; content?: Array<{ type: string; text: string }> }>;
  assertEquals(items.length, 3);
  const tail = items[items.length - 1];
  assertEquals(tail.type, 'message');
  assertEquals(tail.role, 'user');
  assertEquals(tail.content?.[0].type, 'input_text');
});

test('compact + flag off: passes through to run() unchanged', async () => {
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'compact me' }] },
    { action: 'compact', flagOn: false },
  );

  let runCalled = false;
  await withResponsesCompactShim(inv, stubCtx, () => {
    runCalled = true;
    return fakeUpstreamRun('unused')();
  });
  // Flag off: shim early-returns without expansion or pivot. The inner
  // run() is called directly, action stays 'compact', payload unchanged.
  assertEquals(runCalled, true);
  assertEquals(inv.action, 'compact');
});

// ── Bug 1 — engagement gating ────────────────────────────────────────────────
//
// The shim engages when EITHER the per-upstream flag is on OR the candidate's
// targetApi is not 'responses'. The compact-shape check inside (action ===
// 'compact' OR input contains compaction_trigger) decides whether to simulate
// or just pass the request through. Together these gates make the shim
// structurally required on non-Responses upstreams (Messages / Chat
// Completions translation has no `compaction_trigger` variant) while keeping
// the flag as the operator opt-in for Responses-target upstreams.

test('generate + compaction_trigger + flag off + messages target: shim simulates (structurally required)', async () => {
  const inv = makeInvocation(
    {
      input: [
        { type: 'message', role: 'user', content: 'real history' },
        { type: 'compaction_trigger' } as unknown as never,
      ],
    },
    { action: 'generate', flagOn: false, targetApi: 'messages' },
  );

  let seenPayload: ResponsesPayload | undefined;
  const result = await withResponsesCompactShim(inv, stubCtx, () => {
    seenPayload = inv.payload;
    return fakeUpstreamRun('CONDENSED SUMMARY')();
  });

  // The shim should have engaged: the upstream sees the summarization
  // prompt and a stripped (no compaction_trigger) history, and the result
  // is the synthesized `response.compaction` envelope.
  if (!seenPayload) throw new Error('expected the upstream call to fire');
  assertEquals(typeof seenPayload.instructions, 'string');
  assertEquals((seenPayload.instructions as string).includes('CONTEXT CHECKPOINT COMPACTION'), true);
  const innerItems = seenPayload.input as Array<{ type: string }>;
  assertEquals(innerItems.every(i => i.type !== 'compaction_trigger'), true);

  if (result.type !== 'events') throw new Error(`expected events branch, got ${result.type}`);
  const collected = await collectResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.object, 'response.compaction');
});

test('generate + compaction_trigger + flag off + responses target: shim passes through (flag opt-in not taken)', async () => {
  const inv = makeInvocation(
    {
      input: [
        { type: 'message', role: 'user', content: 'real history' },
        { type: 'compaction_trigger' } as unknown as never,
      ],
    },
    { action: 'generate', flagOn: false, targetApi: 'responses' },
  );

  let runCalled = false;
  let seenAction: 'generate' | 'compact' | undefined;
  let seenPayload: ResponsesPayload | undefined;
  await withResponsesCompactShim(inv, stubCtx, () => {
    runCalled = true;
    seenAction = inv.action;
    seenPayload = inv.payload;
    return fakeUpstreamRun('unused')();
  });

  // Shim did not engage — request flowed through untouched.
  assertEquals(runCalled, true);
  assertEquals(seenAction, 'generate');
  // Payload still carries the trigger (no expansion, no strip, no pivot).
  const items = seenPayload?.input as Array<{ type: string }>;
  assertEquals(items.some(i => i.type === 'compaction_trigger'), true);
});

test('generate + compaction_trigger + flag on + messages target: shim simulates (same as flag-off path)', async () => {
  const inv = makeInvocation(
    {
      input: [
        { type: 'message', role: 'user', content: 'real history' },
        { type: 'compaction_trigger' } as unknown as never,
      ],
    },
    { action: 'generate', targetApi: 'messages' },
  );

  let seenPayload: ResponsesPayload | undefined;
  const result = await withResponsesCompactShim(inv, stubCtx, () => {
    seenPayload = inv.payload;
    return fakeUpstreamRun('CONDENSED SUMMARY')();
  });

  if (!seenPayload) throw new Error('expected the upstream call to fire');
  assertEquals((seenPayload.instructions as string).includes('CONTEXT CHECKPOINT COMPACTION'), true);
  if (result.type !== 'events') throw new Error(`expected events branch, got ${result.type}`);
  const collected = await collectResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.object, 'response.compaction');
});

test('generate + flag on: runs inbound expansion but does not pivot', async () => {
  const userItem = { type: 'message' as const, role: 'user' as const, content: 'expanded' };
  const encoded = encodeBase64UrlJson([userItem]);
  const inv = makeInvocation(
    {
      input: [
        { type: 'compaction', id: 'cmp_1', encrypted_content: encoded } as unknown as never,
        { type: 'message', role: 'user', content: 'follow-up' },
      ],
    },
    { action: 'generate' },
  );

  let runCalled = false;
  await withResponsesCompactShim(inv, stubCtx, () => {
    runCalled = true;
    return fakeUpstreamRun('unused')();
  });
  assertEquals(runCalled, true);
  // generate action stays as-is.
  assertEquals(inv.action, 'generate');
  // Inbound expansion ran: the compaction item was replaced by `userItem`.
  const items = inv.payload.input as Array<{ type: string; content?: unknown }>;
  assertEquals(items.length, 2);
  assertEquals(items[0], userItem);
});

test('compact + flag on: upstream api-error propagates', async () => {
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'history' }] },
    { action: 'compact' },
  );

  const errorResult: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> = {
    type: 'api-error',
    source: 'upstream',
    status: 502,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode('{"error":"upstream blew up"}'),
  };
  const result = await withResponsesCompactShim(inv, stubCtx, () => Promise.resolve(errorResult));
  if (result.type !== 'api-error') throw new Error(`expected api-error, got ${result.type}`);
  assertEquals(result.status, 502);
});

// ── Round-trip ────────────────────────────────────────────────────────────────

test('round-trip: outbound synthesis then inbound expansion recovers the summary message', async () => {
  // Step 1: simulate compaction — returns the synthesized envelope with
  // shim-encoded `encrypted_content`.
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'long convo' }] },
    { action: 'compact' },
  );
  const result = await withResponsesCompactShim(inv, stubCtx, fakeUpstreamRun('SUMMARY TEXT'));
  if (result.type !== 'events') throw new Error('expected events');
  const collected = await collectResponsesProtocolEventsToResult(result.events);
  const compactionItem = collected.output[0] as { type: string; id?: string; encrypted_content: string };

  // Step 2: next turn echoes the compaction item back as an input item;
  // inbound expansion replaces it with the summary message.
  const nextTurn: CanonicalResponsesPayload = {
    model: 'test-model',
    input: [
      { type: 'compaction', id: compactionItem.id ?? 'cmp_rt', encrypted_content: compactionItem.encrypted_content } as unknown as never,
    ],
  };
  const expanded = expandShimCompactionItems(nextTurn);
  const items = expanded.input as Array<{ type: string; role: string; content: Array<{ type: string; text: string }> }>;
  assertEquals(items.length, 1);
  assertEquals(items[0].type, 'message');
  assertEquals(items[0].role, 'user');
  assertEquals(items[0].content[0].text, 'SUMMARY TEXT');
});
