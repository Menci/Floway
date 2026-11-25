import { expect, test } from 'vitest';

import { completeInterruptedOpenAIResponses, OpenAIResponsesInterrupted } from '../../../../../src/data-plane/chat/openai-responses/pipeline/websocket-interrupt.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

test('OpenAI Responses interrupts retention loudly when items or bytes overflow', async () => {
  const frames = async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
    yield eventFrame({
      type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_test', summary: [] },
    });
  };
  const options = { failure: () => undefined, responseId: 'resp_test', model: 'model' };
  expect(await Array.fromAsync(completeInterruptedOpenAIResponses(frames(), options, { bytes: 1, items: 10 }))).toMatchObject([
    { type: 'error', cause: { message: 'OpenAI Responses interruption exceeded 1 retained bytes' } },
  ]);
  expect(await Array.fromAsync(completeInterruptedOpenAIResponses(frames(), options, { bytes: 4096, items: 0 }))).toMatchObject([
    { type: 'error', cause: { message: 'OpenAI Responses interruption exceeded 0 retained items' } },
  ]);
});

test('OpenAI Responses interruption completes only the source abort and propagates a transform bug', async () => {
  const abort = { kind: 'abort', cause: new OpenAIResponsesInterrupted() } as const;
  const bug = new TypeError('transform expected another event');
  const options = { failure: () => abort, responseId: 'resp_test', model: 'model' };
  const frames = async function* (failure: unknown): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_test', summary: [] } });
    throw failure;
  };
  expect(await Array.fromAsync(completeInterruptedOpenAIResponses(frames(abort), options))).toMatchObject([
    { type: 'event', event: { type: 'response.output_item.added' } },
    { type: 'event', event: { type: 'response.output_item.interrupted', item_id: 'rs_test' } },
    { type: 'event', event: { type: 'response.incomplete', response: { incomplete_details: { reason: 'interrupted' } } } },
  ]);
  await expect(Array.fromAsync(completeInterruptedOpenAIResponses(frames(bug), options))).rejects.toBe(bug);
});
