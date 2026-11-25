import { expect, test, vi } from 'vitest';

import { openAIResponsesExit, openAIResponsesFactSpace } from '../../../../../src/data-plane/chat/openai-responses/pipeline/facts.ts';
import { answerOpenAIResponsesWebSocketWarmup } from '../../../../../src/data-plane/chat/openai-responses/pipeline/websocket-warmup.ts';
import type { UsageStoreServices } from '../../../../../src/data-plane/pipeline/store-usage.ts';
import { move, run } from '@floway-dev/pipeline';
import { toProviderModelFact } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const { compose, defineStage } = openAIResponsesFactSpace<UsageStoreServices>();
const pipeline = compose('warmup-test', {
  entry: ['request.openaiResponses', 'request.ws.responseId?', 'request.auth.apiKeyId', 'serve.candidate'],
  exit: openAIResponsesExit,
  stages: [answerOpenAIResponsesWebSocketWarmup],
  ending: defineStage({
    name: 'unused',
    request: { needs: [] },
    return: { provides: openAIResponsesExit },
    async execute() { throw new Error('Warmup reached the upstream'); },
  }),
});

test('warmup emits its synthetic completion and propagates a usage write defect to done', async () => {
  const defect = new TypeError('unexpected warmup usage failure');
  const storeUsage = vi.fn<UsageStoreServices['storeUsage']>().mockRejectedValue(defect);
  const handle = run(pipeline, {
    'request.openaiResponses': move({ model: 'test-model', input: [], generate: false }),
    'request.ws.responseId': 'response-id',
    'request.auth.apiKeyId': 'key-id',
    'serve.candidate': move({
      upstream: { id: 'upstream', kind: 'custom' as const, name: 'Provider', config: {} },
      model: toProviderModelFact(stubProviderModel({ id: 'test-model' })),
    }),
  }, { services: { storeUsage } });
  const failed = expect(handle.done).rejects.toBe(defect);
  const result = (await handle.result)['response.openaiResponses'];
  if (result.kind !== 'stream') throw new Error('Expected warmup to produce a stream');
  expect(await Array.fromAsync(result.stream)).toContainEqual(expect.objectContaining({
    ok: true, value: expect.objectContaining({ type: 'response.completed' }),
  }));
  await failed;
  expect(storeUsage).toHaveBeenCalledOnce();
});
