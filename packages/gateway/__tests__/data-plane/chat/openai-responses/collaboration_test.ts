import { expect, test } from 'vitest';

import { applyOpenAIResponsesCollaboration } from '../../../../src/data-plane/chat/openai-responses/collaboration.ts';
import { compose, defineStage } from '../../../../src/data-plane/pipeline/facts.ts';
import type { GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { run, type Result } from '@floway-dev/pipeline';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { toProviderModelFact, type ProtocolStreamError } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

test('collaboration requests ordinary names and restores qualified plaintext calls on the client stream', async () => {
  const keys = ['response.http', 'response.openaiResponses'] as const;
  const ending = defineStage({
    name: 'test.generation',
    request: { needs: ['request.openaiResponses'] },
    return: { provides: keys },
    async execute(facts, scope) {
      const tool = facts['request.openaiResponses'].tools?.[0];
      expect(tool).toMatchObject({ type: 'namespace', name: 'collaboration-optimize' });
      if (tool?.type !== 'namespace') throw new TypeError('Expected a namespace');
      const stream = scope.createStream(async function* (): AsyncGenerator<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>> {
        yield {
          ok: true, value: {
            type: 'response.output_item.done', output_index: 0,
            item: { type: 'function_call', id: 'fc_test', call_id: 'call_test', namespace: tool.name, name: 'send_message', arguments: '{}', status: 'completed' },
          },
        };
      });
      return { 'response.http': null, 'response.openaiResponses': { kind: 'stream', stream } };
    },
  });
  const pipeline = compose('responses-collaboration-test', {
    entry: ['request.openaiResponses', 'provider.model'], exit: keys, stages: [applyOpenAIResponsesCollaboration], ending,
  });
  const controller = new AbortController();
  const running = run(pipeline, {
    'provider.model': toProviderModelFact(stubProviderModel({ enabledFlags: new Set(['openai-responses-collaboration-shim']) })),
    'request.openaiResponses': {
      model: 'model', input: [], tools: [{
        type: 'namespace', name: 'collaboration', description: 'fixture', tools: [{
          type: 'function', name: 'send_message', parameters: { type: 'object' },
        }],
      }],
    },
  }, { services: {} as GatewayServices, signal: controller.signal, waitUntil: () => {} });
  const outcome = (await running.result)['response.openaiResponses'];
  if (outcome.kind !== 'stream') throw new Error('Expected the collaboration stream');
  const items = await Array.fromAsync(running.read(outcome.stream));
  controller.abort();
  await running.done;
  expect(items).toEqual([expect.objectContaining({
    ok: true, value: expect.objectContaining({
      type: 'response.output_item.done',
      item: expect.objectContaining({ namespace: 'collaboration', name: 'send_message', encrypted_function_args: [] }),
    }),
  })]);
});
