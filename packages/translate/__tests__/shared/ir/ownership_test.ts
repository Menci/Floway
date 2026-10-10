import { expect, test } from 'vitest';

import { collect, collectIR, iterate } from './helpers.ts';
import { nativeResult } from './translation-cases.ts';
import { irFromOpenAIChatCompletions } from '../../../src/shared/ir/sse-from/openai-chat-completions/index.ts';
import { geminiGenerateContentFromIR } from '../../../src/shared/ir/sse-to/gemini-generatecontent/index.ts';
import { openaiResponsesFromIR } from '../../../src/shared/ir/sse-to/openai-responses/index.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';

const chunk = (delta: any, extra: any = {}) => eventFrame({ id: 'chat_owner', model: 'served', created: 1, choices: [{ index: 0, delta, finish_reason: null, ...extra }] } as any);
const citation = (start: number, end: number) => ({ type: 'url_citation', url_citation: { start_index: start, end_index: end, url: 'https://example.com', title: 'Source' } });

test('ChatCompletions logprobs retain their text owner when a tool appears in the same chunk', async () => {
  const token = { token: 'hello', logprob: -0.1, bytes: [104, 101, 108, 108, 111], top_logprobs: [] };
  const source = [chunk({ content: 'hello', annotations: [citation(0, 5)], tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, { logprobs: { content: [token], refusal: null }, finish_reason: 'tool_calls' }), doneFrame()];
  const ir = await collectIR(irFromOpenAIChatCompletions(iterate(source)));
  expect(ir.choices[0].items).toHaveLength(2);
  expect(ir.choices[0].logprobs).toEqual([{ scope: 'text_part', item_index: 0, content_index: 0, tokens: [token] }]);
  const frames = await collect(openaiResponsesFromIR(irFromOpenAIChatCompletions(iterate(source))));
  expect(frames.find(frame => frame.type === 'event' && frame.event.type === 'response.output_text.done')).toMatchObject({ event: { logprobs: [token] } });
  const annotation = frames.findIndex(frame => frame.type === 'event' && frame.event.type === 'response.output_text.annotation.added');
  const end = frames.findIndex(frame => frame.type === 'event' && frame.event.type === 'response.output_item.done');
  expect(annotation).toBeGreaterThanOrEqual(0);
  expect(annotation).toBeLessThan(end);
  const result = await nativeResult('openai-responses', frames);
  expect(result.output).toHaveLength(2);
  expect(result.output[0].content[0]).toMatchObject({ text: 'hello', logprobs: [token] });
});

test('ChatCompletions citations rebase cumulative Unicode coordinates across interrupted items', async () => {
  const source = [chunk({ content: 'A😀' }), chunk({ reasoning_text: 'R' }), chunk({ content: '中B' }), chunk({ annotations: [citation(2, 4)] }, { finish_reason: 'stop' }), doneFrame()];
  const ir = await collectIR(irFromOpenAIChatCompletions(iterate(source)));
  expect(ir.choices[0].items[2]).toMatchObject({ content: [{ text: '中B', annotations: [{ output_text_range: { start: 0, end_exclusive: 2 } }] }] });
  const result = await nativeResult('openai-responses', await collect(openaiResponsesFromIR(irFromOpenAIChatCompletions(iterate(source)))));
  expect(result.output[2].content[0].annotations).toEqual([{ type: 'url_citation', url: 'https://example.com', title: 'Source', start_index: 0, end_index: 2 }]);
});

test('late ChatCompletions citations update closed text spans and split cross-item ranges', async () => {
  const source = [chunk({ content: 'A😀' }), chunk({ reasoning_text: 'R' }), chunk({ content: '中B' }), chunk({ reasoning_text: 'tail' }), chunk({ annotations: [citation(1, 3)] }, { finish_reason: 'stop' }), doneFrame()];
  const result = await nativeResult('openai-responses', await collect(openaiResponsesFromIR(irFromOpenAIChatCompletions(iterate(source)))));
  expect(result.output[0].content[0].annotations[0]).toMatchObject({ start_index: 1, end_index: 2 });
  expect(result.output[2].content[0].annotations[0]).toMatchObject({ start_index: 0, end_index: 1 });
  const google = await nativeResult('gemini-generate-content', await collect(geminiGenerateContentFromIR(irFromOpenAIChatCompletions(iterate(source)))));
  expect(google.candidates[0].groundingMetadata.groundingSupports.map((support: any) => support.segment.text)).toEqual(['😀', '中']);
});
