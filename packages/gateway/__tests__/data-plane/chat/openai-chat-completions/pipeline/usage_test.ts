import { expect, test, vi } from 'vitest';

import { openaiChatCompletionsEgressStages } from '../../../../../src/data-plane/chat/openai-chat-completions/pipeline/egress-stages.ts';
import { includeOpenAIChatCompletionsUsage } from '../../../../../src/data-plane/chat/openai-chat-completions/pipeline/include-usage.ts';
import { compose, defineStage } from '../../../../../src/data-plane/chat/pipeline/facts.ts';
import { createGatewayServices } from '../../../../../src/data-plane/pipeline/services.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { candidateFor, hostFor } from '../../../pipeline/fixtures.ts';
import { asEntry, run } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ProtocolStreamError } from '@floway-dev/upstream';

test.each([
  { enabledFlags: [] },
  { enabledFlags: ['usage-exclusive-cached-tokens'] },
] as const)('normalizes native usage with flags $enabledFlags before recording it and observes a late reader error', async ({ enabledFlags }) => {
  initRepo(new InMemoryRepo());
  const recordUsage = vi.fn(async () => {});
  const recordPerformance = vi.fn(async () => {});
  const host = hostFor({
    ...createGatewayServices({
      apiKey: { id: 'key', serverSecret: 'ab'.repeat(32), openaiResponsesRetentionSeconds: 0, upstreamIds: null, randomizeUpstreams: false },
      subject: { id: 1, isAdmin: false },
      runtimeLocation: 'TEST',
      dump: null,
    }),
    recordUsage,
    recordPerformance,
  });
  const finish = Promise.withResolvers<void>();
  const cause = new Error('truncated body');
  const terminal = defineStage({
    name: 'chat-completions-script',
    request: { needs: ['openaiChatCompletions'] },
    return: { provides: ['http', 'openaiChatCompletions', 'usageModelKey?'] },
    async execute(facts, scope) {
      expect(facts.openaiChatCompletions.stream_options?.include_usage).toBe(true);
      const stream = scope.createStream<OpenAIChatCompletionsStreamEvent, ProtocolStreamError>(async function* () {
        yield {
          ok: true,
          value: {
            id: 'chatcmpl_test', created: 1, object: 'chat.completion.chunk', model: 'wire-model',
            choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'hello' } }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 10, prompt_tokens_details: { cached_tokens: 3 } },
          },
        };
        await finish.promise;
        yield { ok: false, error: { kind: 'transport', cause } };
      });
      return {
        http: { status: 200, statusText: '', headers: [], body: null, startedAt: performance.now() },
        openaiChatCompletions: { kind: 'stream', stream },
        usageModelKey: 'pricing-model',
      };
    },
  });
  const entry = asEntry(compose('chat-completions-metering-test', {
    entry: ['openaiChatCompletions', 'model', 'aliasRules', 'upstream'],
    exit: ['http', 'openaiChatCompletions', 'usage', 'usageModelKey?'],
    stages: [includeOpenAIChatCompletionsUsage, ...openaiChatCompletionsEgressStages],
    ending: terminal,
  }));
  const { model, upstream } = candidateFor('custom');
  const execution = run(entry, {
    upstream,
    model: { ...model, enabledFlags },
    aliasRules: {},
    openaiChatCompletions: { model: model.id, messages: [{ role: 'user', content: 'hello' }], stream_options: { include_usage: false } },
  }, host.options);

  const answer = await execution.result;
  if (answer.openaiChatCompletions.kind !== 'stream') throw new Error('Expected the Chat Completions stream');
  const frames = execution.read(answer.openaiChatCompletions.stream);
  const text = await frames.next();
  expect(text.value).toMatchObject({ ok: true, value: { choices: [{ delta: { content: 'hello' } }] } });
  expect(text.value).not.toHaveProperty('value.usage');
  await expect(frames.next()).resolves.toMatchObject({
    value: {
      ok: true, value: { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
    },
  });
  await expect(execution.read(answer.usage)).resolves.toMatchObject({
    kind: 'observed', modelKey: 'pricing-model',
    usage: [{ reported: true, quantities: { input_tokens: '5', input_cache_read_tokens: '3', output_tokens: '2' } }],
  });
  expect(recordUsage).toHaveBeenCalledOnce();
  expect(recordPerformance).not.toHaveBeenCalled();

  finish.resolve();
  const terminalItem = await frames.next();
  expect(terminalItem.value).toEqual({ ok: false, error: { kind: 'transport', cause } });
  if (terminalItem.done || terminalItem.value.ok) throw new Error('Expected the transport failure');
  expect(terminalItem.value.error.cause).toBe(cause);
  await expect(frames.next()).resolves.toMatchObject({ done: true });
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(recordPerformance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ failed: true, operation: 'chat' }));
  expect(host.errors).toEqual([]);
});
