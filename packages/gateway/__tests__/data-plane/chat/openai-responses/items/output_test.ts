import { expect, test, vi } from 'vitest';

import { wrapOpenAIResponsesStatefulOutput } from '../../../../../src/data-plane/chat/openai-responses/client-output.ts';
import { openaiResponsesItemId } from '../../../../../src/data-plane/chat/openai-responses/items/identity.ts';
import { wrapOpenAIResponsesClientOutput } from '../../../../../src/data-plane/chat/openai-responses/items/output.ts';
import { createOpenAIResponsesHttpStore } from '../../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS, testOpenAIResponsesStatePolicy } from '../test-policy.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesOutputReasoning, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const frames = async function* (response: OpenAIResponsesResultEx): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const item = response.output[0];
  yield eventFrame({ type: 'response.output_item.added', output_index: 0, item });
  yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
  yield eventFrame({ type: 'response.completed', response });
  yield doneFrame();
};

const completedReasoningItem: OpenAIResponsesOutputReasoning = Object.freeze({
  type: 'reasoning',
  id: 'rs_upstream',
  summary: [],
});

const memoryOutputHarness = () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  void repo.apiKeys.save({
    id: 'key-a', userId: 1, name: 'OpenAI Responses test key', key: 'raw-responses-test',
    serverSecret: '99'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null, randomizeUpstreams: false, deletedAt: null, dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS,
  });
  return { repo, store: createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true) };
};

const responseFor = (output: OpenAIResponsesResultEx['output']): OpenAIResponsesResultEx => ({
  id: 'resp_upstream',
  object: 'response',
  model: 'model',
  status: 'completed',
  output,
  error: null,
  incomplete_details: null,
});

test('stateless client egress retains terminal-only output without applying a provider-specific recovery policy', async () => {
  const terminalOnly = {
    type: 'message' as const, id: 'msg_terminal', status: 'completed', role: 'assistant' as const,
    content: [{ type: 'output_text' as const, text: 'terminal message', annotations: [] }],
  };
  const response = responseFor([completedReasoningItem, terminalOnly]);
  const events = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: completedReasoningItem });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: completedReasoningItem });
    yield eventFrame({ type: 'response.completed', response });
  };
  const frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[] = [];
  for await (const frame of wrapOpenAIResponsesStatefulOutput(events(), mockChatGatewayCtx())) frames.push(frame);
  const terminal = frames.at(-1);
  if (terminal?.type !== 'event' || terminal.event.type !== 'response.completed') throw new Error('expected completed response');
  expect(terminal.event.response.output).toHaveLength(2);
  expect(terminal.event.response.output[1]).toEqual(terminalOnly);
});

test('client output replaces history when a compaction_summary item closes', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = { type: 'compaction_summary' as const, id: 'cmp_alias', encrypted_content: 'opaque' };
  const commitSnapshot = vi.spyOn(store, 'commitSnapshot');
  const emitted: ProtocolFrame<OpenAIResponsesStreamEventEx>[] = [];

  for await (const frame of wrapOpenAIResponsesClientOutput(frames(responseFor([item])), {
    store,
    responseId: 'resp_public',
  })) emitted.push(frame);

  expect(emitted).toContainEqual(eventFrame({ type: 'response.output_item.done', output_index: 0, item }));
  expect(commitSnapshot).toHaveBeenCalledWith('resp_public', 'replace', ['cmp_alias']);
  expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0))?.itemIds).toEqual(['cmp_alias']);
});

test('client output waits for persistence before publishing output_item.done', async () => {
  const { repo, store } = memoryOutputHarness();
  const insert = repo.openaiResponsesItems.insertMany.bind(repo.openaiResponsesItems);
  let resolveInsertStarted!: () => void;
  const insertStarted = new Promise<void>(resolve => { resolveInsertStarted = resolve; });
  let releaseInsert!: () => void;
  const insertReleased = new Promise<void>(resolve => { releaseInsert = resolve; });
  vi.spyOn(repo.openaiResponsesItems, 'insertMany').mockImplementation(async (items, earliestVisibleCutoff) => {
    resolveInsertStarted();
    await insertReleased;
    await insert(items, earliestVisibleCutoff);
  });
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: completedReasoningItem });
    await new Promise(() => {});
  };
  const iterator = wrapOpenAIResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })[Symbol.asyncIterator]();

  const pendingDone = iterator.next();
  await insertStarted;
  expect(await Promise.race([pendingDone.then(() => true), Promise.resolve(false)])).toBe(false);

  releaseInsert();
  const done = await pendingDone;
  if (done.value?.type !== 'event' || done.value.event.type !== 'response.output_item.done') {
    throw new Error('Expected completed output item');
  }
  const clientId = done.value.event.item.id!;
  expect(await repo.openaiResponsesItems.lookupMany('key-a', [clientId], 0)).toHaveLength(1);
  await iterator.return?.(doneFrame());
});

test('client output persists completed items before rethrowing an iterator error', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = completedReasoningItem;
  const upstreamError = new Error('stream transport failed');
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
    throw upstreamError;
  };
  let clientId: string | undefined;
  const collect = async () => {
    for await (const frame of wrapOpenAIResponsesClientOutput(input(), {
      store,
      responseId: 'resp_public',
    })) {
      if (frame.type === 'event' && frame.event.type === 'response.output_item.done') clientId = openaiResponsesItemId(frame.event.item) ?? undefined;
    }
  };

  await expect(collect()).rejects.toBe(upstreamError);
  expect(clientId).toEqual(expect.any(String));
  expect(await repo.openaiResponsesItems.lookupMany('key-a', [clientId!], 0)).toHaveLength(1);
  expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0)).toBeNull();
});

test('client output refuses to persist an id-less upstream item', async () => {
  const { store } = memoryOutputHarness();
  const item = {
    type: 'message' as const,
    role: 'assistant' as const,
    status: 'completed' as const,
    content: [{ type: 'output_text' as const, text: 'answer', annotations: [] }],
  } as unknown as OpenAIResponsesOutputItemEx;
  const result: OpenAIResponsesResultEx = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [item],
    error: null,
    incomplete_details: null,
  };

  const collect = async () => {
    for await (const _frame of wrapOpenAIResponsesClientOutput(frames(result), {
      store,
      responseId: 'resp_public',
    })) { /* drain */ }
  };

  await expect(collect()).rejects.toThrow();
});

test('stateful output rejects a terminal item that never emitted output_item.done', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = { type: 'reasoning' as const, id: 'rs_terminal_only', summary: [] };
  const response: OpenAIResponsesResultEx = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [item],
    error: null,
    incomplete_details: null,
  };
  const input = (async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
    yield eventFrame({ type: 'response.completed', response });
  })();
  const collect = async () => {
    for await (const _frame of wrapOpenAIResponsesClientOutput(input, {
      store,
      responseId: 'resp_public',
    })) { /* drain */ }
  };

  await expect(collect()).rejects.toThrow();
  expect(await repo.openaiResponsesItems.lookupMany('key-a', [item.id], 0)).toEqual([]);
  expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0)).toBeNull();
});

test('interrupted output persists completed items after a discarded output_index gap', async () => {
  const { repo, store } = memoryOutputHarness();
  const pending = { type: 'reasoning' as const, id: 'rs_pending', summary: [] };
  const completed = { type: 'reasoning' as const, id: 'rs_completed', summary: [] };
  const response: OpenAIResponsesResultEx = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'incomplete',
    output: [completed],
    error: null,
    incomplete_details: { reason: 'interrupted' },
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: pending });
    yield eventFrame({ type: 'response.output_item.added', output_index: 1, item: completed });
    yield eventFrame({ type: 'response.output_item.done', output_index: 1, item: completed });
    yield eventFrame({ type: 'response.output_item.interrupted', response_id: 'resp_public', item_id: pending.id, output_index: 0 });
    yield eventFrame({ type: 'response.incomplete', response });
  };

  for await (const _frame of wrapOpenAIResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) { /* drain */ }

  expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0))?.itemIds).toEqual([completed.id]);
  expect(await repo.openaiResponsesItems.lookupMany('key-a', [pending.id], 0)).toEqual([]);
});

test('snapshot retains completed streamed items omitted from the terminal output', async () => {
  const { repo, store } = memoryOutputHarness();
  const call = {
    type: 'custom_tool_call' as const,
    id: 'ctc_streamed_only',
    call_id: 'call_streamed_only',
    name: 'exec_command',
    input: 'printf floway-repro',
    status: 'completed',
  };
  const response: OpenAIResponsesResultEx = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [],
    error: null,
    incomplete_details: null,
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: call });
    yield eventFrame({ type: 'response.completed', response });
  };

  for await (const _frame of wrapOpenAIResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) { /* drain */ }

  expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0))?.itemIds).toEqual([call.id]);
  expect((await repo.openaiResponsesItems.lookupMany('key-a', [call.id], 0))[0].payload.item).toEqual(call);
});
