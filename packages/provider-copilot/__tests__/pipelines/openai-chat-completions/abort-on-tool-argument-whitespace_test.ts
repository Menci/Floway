import { expect, test } from 'vitest';

import { abortOnToolArgumentWhitespace } from '../../../src/pipelines/openai-chat-completions/abort-on-tool-argument-whitespace.ts';
import { MAX_CONSECUTIVE_WHITESPACE } from '../../../src/pipelines/shared/whitespace-overflow.ts';
import { runStage } from '../stage.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const baseChunk = (overrides: Partial<OpenAIChatCompletionsStreamEvent>): OpenAIChatCompletionsStreamEvent => ({
  id: 'chatcmpl_1',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'test-model',
  choices: [],
  ...overrides,
});

const runWith = async (frames: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[]) => {
  const request = { payload: { model: 'test-model', messages: [] } };
  const result = await runStage(abortOnToolArgumentWhitespace, 'openaiChatCompletions', request, {
    stream: (async function* () {
      for (const frame of frames) {
        if (frame.type === 'event') yield { ok: true, value: frame.event } as const;
      }
    })(),
  });
  if (!result.stream) throw new Error('Expected OpenAI Chat Completions stream');
  const items = await Array.fromAsync(result.stream);
  await result.done;
  return items;
};

test('yields a terminal protocol failure when whitespace exceeds the threshold', async () => {
  const args = '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE + 1);
  const frames: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [
    eventFrame(
      baseChunk({
        id: 'chatcmpl_abort',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'noop', arguments: args } }] },
            finish_reason: null,
          },
        ],
      }),
    ),
    // Subsequent frames should not be observed.
    eventFrame(baseChunk({ choices: [{  index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '\n\n\n' } }] }, finish_reason: null }] })),
    doneFrame(),
  ];

  const items = await runWith(frames);
  expect(items).toEqual([{ ok: false, error: { kind: 'protocol', cause: expect.any(Error) } }]);
});

test('tracks whitespace per tool-call index independently', async () => {
  // Two distinct tool calls in parallel; each near but below threshold.
  // Neither should trigger abort because the per-index counters are separate.
  const args = '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE);
  const frames: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [
    eventFrame(
      baseChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', type: 'function', function: { name: 'a', arguments: args } },
                { index: 1, id: 'call_b', type: 'function', function: { name: 'b', arguments: args } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    ),
    doneFrame(),
  ];

  const out = await runWith(frames);
  expect(out).toEqual(frames.flatMap(frame => frame.type === 'event' ? [{ ok: true, value: frame.event }] : []));
});
