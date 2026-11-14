import { expect, expectTypeOf, test } from 'vitest';

import { eventFrame } from '../../src/common/index.ts';
import type { OpenAIResponsesLogprob, OpenAIResponsesOutputLogprobEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx, OpenAIResponsesStreamLogprob, OpenAIResponsesStreamLogprobEx } from '../../src/openai-responses/index.ts';
import { reassembleOpenAIResponsesEvents } from '../../src/openai-responses/reassemble.ts';
import { parseOpenAIResponsesStream } from '../../src/openai-responses/stream.ts';
import { openaiResponsesProtocolFrameToSSEFrame } from '../../src/openai-responses/to-sse.ts';
import { sseFrameBody } from '../common/test-utils.ts';

test('Responses output and SSE logprobs retain their distinct standard contracts', () => {
  expectTypeOf<OpenAIResponsesLogprob>().toEqualTypeOf<{
    token: string;
    logprob: number;
    bytes: number[];
    top_logprobs: { token: string; logprob: number; bytes: number[] }[];
  }>();
  expectTypeOf<OpenAIResponsesStreamLogprob>().toEqualTypeOf<{
    token: string;
    logprob: number;
    top_logprobs?: { token?: string; logprob?: number }[];
  }>();
  expectTypeOf<OpenAIResponsesOutputLogprobEx>().toExtend<OpenAIResponsesStreamLogprobEx>();
});

const resultWithLogprobs = (logprobs: OpenAIResponsesOutputLogprobEx[]): OpenAIResponsesResultEx => ({
  id: 'response',
  object: 'response',
  model: 'model',
  status: 'completed',
  error: null,
  incomplete_details: null,
  output: [{
    type: 'message', id: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'answer', annotations: [], logprobs }],
  }],
});

const preserveLogprobs = async (logprobs: OpenAIResponsesOutputLogprobEx[]): Promise<void> => {
  const result = resultWithLogprobs(logprobs);
  const nativeEvents: OpenAIResponsesStreamEventEx[] = [
    { type: 'response.output_text.delta', sequence_number: 0, item_id: 'message', output_index: 0, content_index: 0, delta: 'answer', logprobs },
    { type: 'response.output_text.done', sequence_number: 1, item_id: 'message', output_index: 0, content_index: 0, text: 'answer', logprobs },
    { type: 'response.completed', sequence_number: 2, response: result },
  ];
  const frames = [];
  for await (const frame of parseOpenAIResponsesStream(sseFrameBody(...nativeEvents.map(event => openaiResponsesProtocolFrameToSSEFrame(eventFrame(event)))))) {
    if (frame.type === 'event') frames.push(frame);
  }
  const spans = frames.flatMap(frame => frame.event.type === 'response.output_text.delta' || frame.event.type === 'response.output_text.done' ? [frame.event.logprobs] : []);
  expect(spans).toEqual([logprobs, logprobs]);
  const restored = await reassembleOpenAIResponsesEvents((async function* () {
    for (const frame of frames) yield frame.event;
  })());
  expect(restored).toEqual(result);
};

test('Responses native streams preserve standard SSE alternatives with omitted fields', async () => {
  const logprobs: OpenAIResponsesStreamLogprob[] = [
    { token: 'a', logprob: -1 },
    { token: 'b', logprob: -2, top_logprobs: [{}, { token: 'c' }, { logprob: -3 }] },
  ];
  await preserveLogprobs(logprobs);
});

test('Responses compatibility streams preserve null and absent source byte metadata', async () => {
  const logprobs: OpenAIResponsesStreamLogprobEx[] = [
    { token: 'a', logprob: -1, bytes: null, top_logprobs: [{ token: 'b', logprob: -2, bytes: null }] },
    { token: 'c', logprob: -3, top_logprobs: [{ logprob: -4 }] },
  ];
  await preserveLogprobs(logprobs);
});
