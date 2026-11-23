import { test } from 'vitest';

import { driveResponsesStage, type Frame, type UpstreamEvents, type UpstreamScalar } from './drive.ts';
import { SUMMARY_PREFIX, expandShimCompactionItems } from '../../../../../src/data-plane/chat/openai-responses/compact-payload.ts';
import { syntheticEventsFromCompaction } from '../../../../../src/data-plane/chat/openai-responses/items/output.ts';
import { compactShim } from '../../../../../src/data-plane/chat/openai-responses/stages/compact-shim.ts';
import { tokenCountsFromUsage } from '../../../../../src/repo/usage-metrics.ts';
import { encodeBase64UrlJson } from '../../../../../src/shared/base64url-json.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type OpenAIResponsesCompactionItemEx, type OpenAIResponsesCompactionResultEx, collectOpenAIResponsesProtocolEventsToResult, type CanonicalOpenAIResponsesPayload, type CanonicalOpenAIResponsesInputItem, type OpenAIResponsesPayloadEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi, FlagId, OpenAIResponsesAction } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

interface Invocation {
  payload: CanonicalOpenAIResponsesPayload;
  action: OpenAIResponsesAction;
  enabledFlags: ReadonlySet<FlagId>;
  targetApi: ChatTargetApi;
}

const scriptedEvents = (events: AsyncIterable<Frame>): UpstreamEvents => ({ events });

const runCompact = async (invocation: Invocation, respond: () => Promise<UpstreamEvents | UpstreamScalar>) => {
  const { result, done, logs, usage, performance } = await driveResponsesStage(compactShim, invocation.payload, {
    enabledFlags: invocation.enabledFlags, targetApi: invocation.targetApi, action: invocation.action,
    upstream: (payload, action) => {
      invocation.payload = payload;
      invocation.action = action;
      return respond();
    },
  });
  const outcome = result['response.openaiResponses'];
  if (outcome.kind === 'error') throw new Error('Expected a successful compact result');
  const stream = outcome.kind === 'stream' ? outcome.events : syntheticEventsFromCompaction(outcome.result);
  return {
    usage,
    performance,
    logs,
    events: (async function* () {
      for await (const frame of stream) {
        if (frame.type === 'transport-error') throw new Error(frame.error.message);
        yield frame;
      }
      assertEquals(await done, { ok: true });
    })(),
  };
};

const makeInvocation = (
  payload: Partial<OpenAIResponsesPayloadEx> = {},
  options: { action?: 'generate' | 'compact'; flagOn?: boolean; decryptFlagOn?: boolean; targetApi?: 'openaiResponses' | 'anthropicMessages' | 'openaiChatCompletions' } = {},
): Invocation => {
  const enabledFlags = new Set<FlagId>();
  if (options.flagOn !== false) enabledFlags.add('openai-responses-compact-shim');
  if (options.decryptFlagOn === true) enabledFlags.add('openai-responses-compact-decrypt');
  return {
    payload: { model: 'test-model', input: [], ...payload } as CanonicalOpenAIResponsesPayload,
    action: options.action ?? 'generate',
    enabledFlags,
    targetApi: options.targetApi ?? 'openaiResponses',
  };
};

const fakeUpstreamRun = (summaryText: string, cached = 0): () => Promise<UpstreamEvents> => {
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
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, ...(cached ? { input_tokens_details: { cached_tokens: cached } } : {}) },
  };
  return () => Promise.resolve(scriptedEvents(
    (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
      yield eventFrame({ type: 'response.output_item.added', sequence_number: 0, output_index: 0, item: response.output[0] });
      yield eventFrame({ type: 'response.output_item.done', sequence_number: 1, output_index: 0, item: response.output[0] });
      yield eventFrame({ type: 'response.completed', sequence_number: 2, response });
      yield doneFrame();
    })(),
  ));
};

// ── Inbound expansion (expandShimCompactionItems) ────────────────────────────

test('inbound: foreign compaction blob (non-base64url-JSON) round-trips untouched', () => {
  const original = {
    model: 'm',
    input: [
      { type: 'compaction', id: 'cmp_native', encrypted_content: 'OPAQUE_NATIVE_BLOB' } as const,
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
  const result = await runCompact(inv, () => {
    seenPayload = inv.payload;
    seenAction = inv.action;
    return fakeUpstreamRun('CONDENSED SUMMARY')();
  });

  // Inner action seen by the upstream is 'generate'.
  assertEquals(seenAction, 'generate');
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
  const expanded = expandShimCompactionItems({ model: 'test-model', input: [compactionItem as CanonicalOpenAIResponsesInputItem] });
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
  const runIncomplete = (): Promise<UpstreamEvents> => {
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
    return Promise.resolve(scriptedEvents(
      (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
        yield eventFrame({ type: 'response.completed', sequence_number: 0, response });
        yield doneFrame();
      })(),
    ));
  };
  const result = await runCompact(inv, runIncomplete);
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
  const seenInputs: CanonicalOpenAIResponsesInputItem[][] = [];
  let calls = 0;

  const result = await runCompact(inv, async () => {
    calls += 1;
    seenInputs.push(inv.payload.input);
    return await fakeUpstreamRun(calls === 1 ? '   ' : 'LEGACY SUMMARY', calls === 1 ? 8 : 0)();
  });

  assertEquals(calls, 2);
  assertEquals(result.logs.some(message => message.includes('retrying with the legacy system-prompt summarizer')), true);

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

  const collected = await collectOpenAIResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.usage, { input_tokens: 20, output_tokens: 40, total_tokens: 60, input_tokens_details: { cached_tokens: 8 } });
  assertEquals(result.usage.map(row => tokenCountsFromUsage(row).input_cache_read ?? 0), [8, 0]);
  assertEquals(result.performance.length, 2);
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

  const nativeResponse = {
    id: 'resp_native_compact',
    object: 'response.compaction',
    model: 'test-upstream-model',
    status: 'completed',
    output: [
      { type: 'message', id: 'msg_retained', role: 'user', status: 'completed', content: [{ type: 'input_text', text: 'retained tail' }] },
      { type: 'compaction', id: 'cmp_native_1', encrypted_content: 'OPAQUE_NATIVE_BLOB_1' },
      { type: 'message', id: 'msg_between', role: 'assistant', status: 'completed', content: [{ type: 'input_text', text: 'retained middle' }] },
      { type: 'compaction_summary', id: 'cmp_native_2', encrypted_content: 'OPAQUE_NATIVE_BLOB_2' },
    ],
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
  } satisfies OpenAIResponsesCompactionResultEx & Pick<OpenAIResponsesResultEx, 'model' | 'status' | 'error' | 'incomplete_details'>;

  let calls = 0;
  const result = await runCompact(inv, async () => {
    calls += 1;
    if (calls === 1) {
      assertEquals(inv.action, 'compact');
      return {
        result: nativeResponse,
      };
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
    return await fakeUpstreamRun(`EXACT DECRYPTED SUMMARY ${calls - 1}`)();
  });

  assertEquals(calls, 3);
  const collected = await collectOpenAIResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.object, 'response.compaction');
  assertEquals(collected.output[0], nativeResponse.output[0]);
  assertEquals(collected.output[2], nativeResponse.output[2]);
  assertEquals(collected.output.map(item => item.type), ['message', 'compaction', 'message', 'compaction_summary']);
  assertEquals(collected.output[1].id, 'cmp_native_1');
  assertEquals(collected.output[3].id, 'cmp_native_2');
  assertEquals(collected.usage, { input_tokens: 120, output_tokens: 80, total_tokens: 200 });
  assertEquals(result.usage.map(row => tokenCountsFromUsage(row).input), [100, 10, 10]);
  assertEquals(result.performance.length, 3);

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
        { type: 'compaction', id: 'cmp_decrypted', encrypted_content: encoded },
        { type: 'message', role: 'user', content: 'continue' },
      ],
    },
    { flagOn: false },
  );

  let seenInput: CanonicalOpenAIResponsesInputItem[] | undefined;
  await runCompact(inv, () => {
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
        { type: 'compaction_trigger' },
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
  const result = await runCompact(inv, async () => {
    calls += 1;
    if (calls === 1) {
      return scriptedEvents(
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
      );
    }

    assertEquals(inv.action, 'generate');
    assertEquals(inv.payload.store, false);
    assertEquals(inv.payload.input.length, 3);
    const [, replayCompaction] = inv.payload.input;
    assertEquals(replayCompaction, nativeCompactionItem);

    const replay = await fakeUpstreamRun('DECRYPTED CAPTURE SUMMARY')();
    return {
      ...replay,
      usage: Promise.resolve({ input: 15, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 25 }),
    };
  });

  assertEquals(calls, 2);
  const collected = await collectOpenAIResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.output.length, 1);
  const decryptedItem = collected.output[0] as OpenAIResponsesCompactionItemEx;
  assertEquals(decryptedItem.type, 'compaction');
  assertEquals(decryptedItem.id, 'cmp_native_capture');
  assertEquals(decryptedItem.metadata, { turn_id: 'turn-123' });
  assertEquals(decryptedItem.internal_chat_message_metadata_passthrough, { turn_id: 'turn-123' });

  const expanded = expandShimCompactionItems({
    model: 'test-model',
    input: [decryptedItem as CanonicalOpenAIResponsesInputItem],
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
        { type: 'compaction_trigger' },
      ],
    },
    { action: 'generate', flagOn: false, targetApi: 'anthropicMessages' },
  );

  let seenPayload: OpenAIResponsesPayloadEx | undefined;
  const result = await runCompact(inv, () => {
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

  const collected = await collectOpenAIResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.object, 'response.compaction');
});
