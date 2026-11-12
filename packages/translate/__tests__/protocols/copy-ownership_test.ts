import { expect, test } from 'vitest';

import { readAnthropicMessagesEvents, readOpenAIChatCompletionsEvents, readOpenAIResponsesEvents } from './helpers.ts';
import { collect, iterate } from '../shared/iterables.ts';
import { eventFrame } from '@floway-dev/protocols/common';

test.each([
  ['ChatCompletions', readOpenAIChatCompletionsEvents, (error: object) => ({ id: 'chat', model: 'm', choices: [], error })],
  ['Responses', readOpenAIResponsesEvents, (error: object) => ({ type: 'error', error })],
  ['Messages', readAnthropicMessagesEvents, (error: object) => ({ type: 'error', error })],
] as const)('%s reader transfers immutable error objects without copying', async (_name, reader, event) => {
  const error = Object.freeze({ type: 'api_error', message: 'original', details: Object.freeze([Object.freeze({ text: 'original' })]) });
  const frames = await collect(reader(iterate([eventFrame(event(error) as any)])));
  const record = frames.find(record => record.type === 'error');
  expect(record?.error).toBe(error);
});
