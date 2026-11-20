import { test, vi } from 'vitest';

import { SUMMARY_PREFIX, expandShimCompactionItems, withOpenAIResponsesCompactShim } from '../../../../../src/data-plane/chat/openai-responses/interceptors/compact-shim.ts';
import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { encodeBase64UrlJson } from '../../../../../src/shared/base64url-json.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type OpenAIResponsesCompactionItemEx, collectOpenAIResponsesProtocolEventsToResult, type CanonicalOpenAIResponsesPayload, type CanonicalOpenAIResponsesInputItem, type OpenAIResponsesPayloadEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { eventResult, type ExecuteResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

const makeInvocation = (
  payload: Partial<OpenAIResponsesPayloadEx> = {},
  options: { action?: 'generate' | 'compact'; flagOn?: boolean; decryptFlagOn?: boolean; targetApi?: 'openaiResponses' | 'anthropicMessages' | 'openaiChatCompletions' } = {},
): OpenAIResponsesInvocation => {
  const enabledFlags = new Set<FlagId>();
  if (options.flagOn !== false) enabledFlags.add('openai-responses-compact-shim');
  if (options.decryptFlagOn === true) enabledFlags.add('openai-responses-compact-decrypt');
  return {
    payload: { model: 'test-model', input: [], ...payload } as CanonicalOpenAIResponsesPayload,
    action: options.action ?? 'generate',
    candidate: stubModelCandidate({ enabledFlags }),
    targetApi: options.targetApi ?? 'openaiResponses',
    headers: new Headers(),
  };
};

const fakeUpstreamRun = (summaryText: string): () => Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>> => {
  const response: OpenAIResponsesResultEx = {
    id: 'resp_fake_upstream',
    object: 'response',
    model: 'test-upstream-model',
    status: 'completed',
    output: [{
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: summaryText, annotations: [] }],
    }],
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  };
  return () => Promise.resolve(eventResult(
    (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
      yield eventFrame({ type: 'response.output_item.added', sequence_number: 0, output_index: 0, item: response.output[0] });
      yield eventFrame({ type: 'response.output_item.done', sequence_number: 1, output_index: 0, item: response.output[0] });
      yield eventFrame({ type: 'response.completed', sequence_number: 2, response });
      yield doneFrame();
    })(),
    testTelemetryModelIdentity,
  ));
};

// ── Inbound expansion (expandShimCompactionItems) ────────────────────────────

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

// ── Outbound summarization (withOpenAIResponsesCompactShim) ────────────────────────

test('compact + flag on: appends one cache-sharing user prompt and returns a compaction envelope', async () => {
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'long conversation history' }] },
    { action: 'compact' },
  );

  let seenPayload: OpenAIResponsesPayloadEx | undefined;
  let seenAction: 'generate' | 'compact' | undefined;
  const result = await withOpenAIResponsesCompactShim(inv, stubCtx, () => {
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
  // The ordinary history remains the request prefix and one user-role summary
  // instruction is appended, allowing the upstream to reuse its prompt cache.
  if (!seenPayload) throw new Error('expected the upstream call to see the rewritten payload');
  const rewrittenInput = seenPayload.input as CanonicalOpenAIResponsesInputItem[];
  assertEquals(rewrittenInput[0], { type: 'message', role: 'user', content: 'long conversation history' });
  const summaryRequest = rewrittenInput[1] as { type: string; role: string };
  assertEquals(summaryRequest.type, 'message');
  assertEquals(summaryRequest.role, 'user');
  assertEquals(seenPayload.store, false);

  const collected = await collectOpenAIResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.object, 'response.compaction');
  const compactionItem = collected.output[0] as OpenAIResponsesCompactionItemEx;
  assertEquals(compactionItem.type, 'compaction');
  // The next turn echoes the item back; expansion recovers the summary behind the handoff prefix.
  const expanded = expandShimCompactionItems({ model: 'test-model', input: [compactionItem as unknown as CanonicalOpenAIResponsesInputItem] });
  assertEquals(expanded.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `${SUMMARY_PREFIX}\nCONDENSED SUMMARY` }] }]);
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
  const runIncomplete = (): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>> => {
    const response: OpenAIResponsesResultEx = {
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
        content: [{ type: 'output_text', text: 'partial summary', annotations: [] }],
      }],
      error: null,
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    };
    return Promise.resolve(eventResult(
      (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
        yield eventFrame({ type: 'response.completed', sequence_number: 0, response });
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ));
  };
  const result = await withOpenAIResponsesCompactShim(inv, stubCtx, runIncomplete);
  if (result.type !== 'events') throw new Error('expected events branch');
  const collected = await collectOpenAIResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.status, 'incomplete');
  assertEquals(collected.incomplete_details, { reason: 'max_output_tokens' });
});

test('compact + flag on: empty cache-sharing output warns, retries the legacy system summarizer, and combines usage', async () => {
  const inv = makeInvocation(
    {
      input: [{ type: 'message', role: 'user', content: 'history' }],
      tools: [{ type: 'function', name: 'read_file', parameters: null, strict: null }],
    },
    { action: 'compact' },
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const seenInputs: CanonicalOpenAIResponsesInputItem[][] = [];
  let calls = 0;

  const result = await withOpenAIResponsesCompactShim(inv, stubCtx, async () => {
    calls += 1;
    seenInputs.push(inv.payload.input);
    const result = await fakeUpstreamRun(calls === 1 ? '   ' : 'LEGACY SUMMARY')();
    if (result.type !== 'events') return result;
    return {
      ...result,
      finalMetadata: Promise.resolve({
        modelIdentity: testTelemetryModelIdentity,
        billableUsage: { input: 10, cacheRead: calls === 1 ? 8 : 0, cacheWrite: 0, cacheWrite1h: 0, output: 20 },
      }),
    };
  });

  assertEquals(calls, 2);
  warn.mockRestore();

  assertEquals(seenInputs[0]?.map(item => item.type), ['message', 'message']);
  assertEquals(seenInputs[1]?.map(item => item.type), ['message', 'message', 'message']);
  const legacySystem = seenInputs[1]?.[0];
  if (legacySystem?.type !== 'message') throw new Error('expected legacy system message');
  assertEquals(legacySystem.role, 'system');
  assertEquals(seenInputs[1]?.[1], { type: 'message', role: 'user', content: 'history' });
  const legacyTail = seenInputs[1]?.[2];
  if (legacyTail?.type !== 'message') throw new Error('expected legacy terminal user message');
  assertEquals(legacyTail.role, 'user');
  assertEquals(inv.payload.tools, [{ type: 'function', name: 'read_file', parameters: null, strict: null }]);

  if (result.type !== 'events') throw new Error(`expected events branch, got ${result.type}`);
  const collected = await collectOpenAIResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.usage, { input_tokens: 20, output_tokens: 40, total_tokens: 60 });
  assertEquals((await result.finalMetadata)?.billableUsage, {
    input: 20,
    cacheRead: 8,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output: 40,
  });
});

test('compact decrypt: replays mixed compaction items individually and preserves their output positions', async () => {
  const inv = makeInvocation(
    {
      input: [{ type: 'message', role: 'user', content: 'compact me' }],
      instructions: 'caller instructions must not enter the replay turn',
      tools: [{ type: 'function', name: 'irrelevant', parameters: null, strict: null }],
    },
    { action: 'compact', flagOn: false, decryptFlagOn: true },
  );

  const nativeResponse: OpenAIResponsesResultEx = {
    id: 'resp_native_compact',
    object: 'response.compaction',
    model: 'test-upstream-model',
    status: 'completed',
    output: [
      { type: 'message', id: 'msg_retained', role: 'user', status: 'completed', content: [{ type: 'input_text', text: 'retained tail' }] } as unknown as never,
      { type: 'compaction', id: 'cmp_native_1', encrypted_content: 'OPAQUE_NATIVE_BLOB_1' },
      { type: 'message', id: 'msg_between', role: 'assistant', status: 'completed', content: [{ type: 'input_text', text: 'retained middle' }] } as unknown as never,
      { type: 'compaction_summary', id: 'cmp_native_2', encrypted_content: 'OPAQUE_NATIVE_BLOB_2' },
    ],
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
  };

  let calls = 0;
  const result = await withOpenAIResponsesCompactShim(inv, stubCtx, async () => {
    calls += 1;
    if (calls === 1) {
      assertEquals(inv.action, 'compact');
      return eventResult(
        (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
          yield eventFrame({ type: 'response.completed', sequence_number: 0, response: nativeResponse });
          yield doneFrame();
        })(),
        testTelemetryModelIdentity,
        {
          finalMetadata: Promise.resolve({
            modelIdentity: testTelemetryModelIdentity,
            billableUsage: { input: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 40 },
          }),
        },
      );
    }

    assertEquals(inv.action, 'generate');
    assertEquals(inv.payload.store, false);
    assertEquals(inv.payload.instructions, undefined);
    assertEquals(inv.payload.tools, undefined);
    assertEquals(inv.payload.input.length, 3);
    const [prefix, compaction, suffix] = inv.payload.input;
    assertEquals(prefix.type, 'message');
    if (prefix.type !== 'message') throw new Error('expected prefix message');
    assertEquals(prefix.role, 'system');
    assertEquals(prefix.content, [{
      type: 'input_text',
      text: 'Repeat the following text exactly, which may contain a compaction summary, character for character.',
    }]);
    assertEquals(compaction, nativeResponse.output[calls === 2 ? 1 : 3]);
    assertEquals(suffix.type, 'message');
    if (suffix.type !== 'message') throw new Error('expected suffix message');
    assertEquals(suffix.role, 'system');
    assertEquals(suffix.content, [{
      type: 'input_text',
      text: 'Output only the exact summary text, with no preface, explanation, markdown fence, or changes.',
    }]);
    const replay = await fakeUpstreamRun(`EXACT DECRYPTED SUMMARY ${calls - 1}`)();
    if (replay.type !== 'events') throw new Error('expected replay events');
    return {
      ...replay,
      finalMetadata: Promise.resolve({
        modelIdentity: testTelemetryModelIdentity,
        billableUsage: { input: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 20 },
      }),
    };
  });

  assertEquals(calls, 3);
  if (result.type !== 'events') throw new Error(`expected events branch, got ${result.type}`);
  const collected = await collectOpenAIResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.object, 'response.compaction');
  assertEquals(collected.output[0], nativeResponse.output[0]);
  assertEquals(collected.output[2], nativeResponse.output[2]);
  assertEquals(collected.output.map(item => item.type), ['message', 'compaction', 'message', 'compaction_summary']);
  assertEquals(collected.output[1].id, 'cmp_native_1');
  assertEquals(collected.output[3].id, 'cmp_native_2');
  assertEquals(collected.usage, { input_tokens: 120, output_tokens: 80, total_tokens: 200 });
  assertEquals((await result.finalMetadata)?.billableUsage, {
    input: 120,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output: 80,
  });

  const expanded = expandShimCompactionItems({
    model: 'm',
    input: collected.output.slice(1) as CanonicalOpenAIResponsesInputItem[],
  });
  assertEquals(expanded.input, [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'EXACT DECRYPTED SUMMARY 1' }],
    },
    nativeResponse.output[2],
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'EXACT DECRYPTED SUMMARY 2' }],
    },
  ]);
});

test('gateway-owned compaction expands on an ordinary generate request even when both compact flags are off', async () => {
  const encoded = encodeBase64UrlJson([{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'RECOVERED SUMMARY' }],
  }]);
  const inv = makeInvocation(
    {
      input: [
        { type: 'compaction', id: 'cmp_decrypted', encrypted_content: encoded } as unknown as never,
        { type: 'message', role: 'user', content: 'continue' },
      ],
    },
    { flagOn: false },
  );

  let seenInput: CanonicalOpenAIResponsesInputItem[] | undefined;
  await withOpenAIResponsesCompactShim(inv, stubCtx, () => {
    seenInput = inv.payload.input;
    return fakeUpstreamRun('done')();
  });

  assertEquals(seenInput, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'RECOVERED SUMMARY' }] },
    { type: 'message', role: 'user', content: 'continue' },
  ]);
});

test('compact decrypt: decrypts provider-restored native compaction output with intermediate compacting events', async () => {
  const inv = makeInvocation(
    {
      input: [
        { type: 'message', role: 'user', content: 'prior turn' },
        { type: 'compaction_trigger' } as unknown as never,
      ],
    },
    { flagOn: false, decryptFlagOn: true },
  );

  const nativeCompactionItem = {
    type: 'compaction',
    id: 'cmp_native_capture',
    encrypted_content: 'OPAQUE_CAPTURE_BLOB',
    metadata: { turn_id: 'turn-123' },
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-123' },
  } as OpenAIResponsesCompactionItemEx;

  const inProgressEnvelope: OpenAIResponsesResultEx = {
    id: 'resp_capture',
    object: 'response',
    model: 'test-upstream-model',
    status: 'in_progress',
    output: [],
    error: null,
    incomplete_details: null,
  };

  const completedEnvelope: OpenAIResponsesResultEx = {
    id: 'resp_capture',
    object: 'response',
    model: 'test-upstream-model',
    status: 'completed',
    output: [nativeCompactionItem],
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 150, output_tokens: 50, total_tokens: 200 },
  };

  let calls = 0;
  const result = await withOpenAIResponsesCompactShim(inv, stubCtx, async () => {
    calls += 1;
    if (calls === 1) {
      return eventResult(
        (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
          yield eventFrame({ type: 'response.created', sequence_number: 0, response: inProgressEnvelope });
          yield eventFrame({ type: 'response.in_progress', sequence_number: 1, response: inProgressEnvelope });
          yield eventFrame({
            type: 'response.output_item.added',
            sequence_number: 2,
            output_index: 0,
            item: nativeCompactionItem,
          });
          yield eventFrame({
            type: 'response.compaction.compacting',
            sequence_number: 3,
            item_id: 'cmp_native_capture',
            output_index: 0,
          });
          yield eventFrame({
            type: 'response.compaction.compacting',
            sequence_number: 4,
            item_id: 'cmp_native_capture',
            output_index: 0,
          });
          yield eventFrame({
            type: 'response.output_item.done',
            sequence_number: 5,
            output_index: 0,
            item: nativeCompactionItem,
          });
          yield eventFrame({ type: 'response.completed', sequence_number: 6, response: completedEnvelope });
          yield doneFrame();
        })(),
        testTelemetryModelIdentity,
        {
          finalMetadata: Promise.resolve({
            modelIdentity: testTelemetryModelIdentity,
            billableUsage: { input: 150, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 50 },
          }),
        },
      );
    }

    assertEquals(inv.action, 'generate');
    assertEquals(inv.payload.store, false);
    assertEquals(inv.payload.input.length, 3);
    const [, replayCompaction] = inv.payload.input;
    assertEquals(replayCompaction, nativeCompactionItem);

    const replay = await fakeUpstreamRun('DECRYPTED CAPTURE SUMMARY')();
    if (replay.type !== 'events') throw new Error('expected replay events');
    return {
      ...replay,
      finalMetadata: Promise.resolve({
        modelIdentity: testTelemetryModelIdentity,
        billableUsage: { input: 15, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 25 },
      }),
    };
  });

  assertEquals(calls, 2);
  if (result.type !== 'events') throw new Error(`expected events branch, got ${result.type}`);
  const collected = await collectOpenAIResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.output.length, 1);
  const decryptedItem = collected.output[0] as OpenAIResponsesCompactionItemEx;
  assertEquals(decryptedItem.type, 'compaction');
  assertEquals(decryptedItem.id, 'cmp_native_capture');
  assertEquals(decryptedItem.metadata, { turn_id: 'turn-123' });
  assertEquals(decryptedItem.internal_chat_message_metadata_passthrough, { turn_id: 'turn-123' });

  const expanded = expandShimCompactionItems({
    model: 'test-model',
    input: [decryptedItem as unknown as CanonicalOpenAIResponsesInputItem],
  });
  const expandedUserMessage = expanded.input[0] as {
    type: string;
    role: string;
    content: Array<{ type: string; text: string }>;
  };
  assertEquals(expandedUserMessage.type, 'message');
  assertEquals(expandedUserMessage.role, 'user');
  assertEquals(expandedUserMessage.content[0].text, 'DECRYPTED CAPTURE SUMMARY');
});

// ── Bug 1 — engagement gating ────────────────────────────────────────────────
//
// The shim engages when EITHER the per-upstream flag is on OR the candidate's
// targetApi is not 'openaiResponses'. The compact-shape check inside (action ===
// 'compact' OR input contains compaction_trigger) decides whether to simulate
// or just pass the request through. Together these gates make the shim
// structurally required on non-OpenAI-Responses upstreams (Anthropic Messages /
// OpenAI Chat Completions translation has no `compaction_trigger` variant) while
// keeping the flag as the operator opt-in for OpenAI-Responses-target upstreams.

test('generate + compaction_trigger + flag off + messages target: shim simulates (structurally required)', async () => {
  const inv = makeInvocation(
    {
      input: [
        { type: 'message', role: 'user', content: 'real history' },
        { type: 'compaction_trigger' } as unknown as never,
      ],
    },
    { action: 'generate', flagOn: false, targetApi: 'anthropicMessages' },
  );

  let seenPayload: OpenAIResponsesPayloadEx | undefined;
  const result = await withOpenAIResponsesCompactShim(inv, stubCtx, () => {
    seenPayload = inv.payload;
    return fakeUpstreamRun('CONDENSED SUMMARY')();
  });

  // The shim should have engaged: the upstream sees the ordinary history as
  // its prefix, one appended summary request, and no compaction_trigger.
  if (!seenPayload) throw new Error('expected the upstream call to fire');
  const innerItems = seenPayload.input as CanonicalOpenAIResponsesInputItem[];
  assertEquals(innerItems[0], { type: 'message', role: 'user', content: 'real history' });
  const tail = innerItems.at(-1);
  if (tail?.type !== 'message') throw new Error('expected summary request message');
  assertEquals(tail.role, 'user');
  assertEquals(innerItems.every(i => i.type !== 'compaction_trigger'), true);

  if (result.type !== 'events') throw new Error(`expected events branch, got ${result.type}`);
  const collected = await collectOpenAIResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.object, 'response.compaction');
});
