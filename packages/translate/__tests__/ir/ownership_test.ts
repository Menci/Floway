import { expect, test, vi } from 'vitest';

import { collect, collectIR, geminiGenerateContentFromIR, irFromAnthropicMessages, irFromOpenAIChatCompletions, iterate, openaiChatCompletionsFromIR, openaiResponsesFromIR } from './helpers.ts';
import { nativeResult } from './translation-cases.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';

const chunk = (delta: any, extra: any = {}) => eventFrame({ id: 'chat_owner', model: 'served', created: 1, choices: [{ index: 0, delta, finish_reason: null, ...extra }] } as any);
const citation = (start: number, end: number) => ({ type: 'url_citation', url_citation: { start_index: start, end_index: end, url: 'https://example.com', title: 'Source' } });

const messagesCitationFrames = (citedText?: string) => [
  eventFrame({ type: 'message_start', message: { id: 'msg_cite', model: 'claude-test', content: [], usage: { input_tokens: 1, output_tokens: 0 } } } as any),
  eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } } as any),
  eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'See the docs cited inline.' } } as any),
  eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'search_result_location', source: 'https://docs.example.com/page-1', title: 'Example Docs', ...(citedText === undefined ? {} : { cited_text: citedText }) } } } as any),
  eventFrame({ type: 'content_block_stop', index: 0 } as any),
  eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as any),
  eventFrame({ type: 'message_stop' } as any),
];

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
  expect(result.output.filter((item: any) => item.type !== 'reasoning' || typeof item.encrypted_content !== 'string')).toHaveLength(2);
  expect(result.output[0].content[0]).toMatchObject({ text: 'hello', logprobs: [token] });
});

test('ChatCompletions citations rebase cumulative Unicode coordinates across interrupted items', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const source = [chunk({ content: 'A😀' }), chunk({ reasoning_text: 'R' }), chunk({ content: '中B' }), chunk({ annotations: [citation(1, 3)] }, { finish_reason: 'stop' }), doneFrame()];
  const ir = await collectIR(irFromOpenAIChatCompletions(iterate(source)));
  expect(ir.choices[0].items[0]).toMatchObject({ content: [{ text: 'A😀' }] });
  expect(ir.choices[0].items[2]).toMatchObject({ content: [{ text: '中B', annotations: [{ output_text_range: { start: 0, end_exclusive: 1 } }] }] });
  const result = await nativeResult('openai-responses', await collect(openaiResponsesFromIR(irFromOpenAIChatCompletions(iterate(source)))));
  expect(result.output[2].content[0].annotations).toEqual([{ type: 'url_citation', url: 'https://example.com', title: 'Source', start_index: 0, end_index: 1 }]);
  expect(warning).toHaveBeenCalledWith('Clamping ChatCompletions citation to open text', expect.objectContaining({ choice: 0 }));
  warning.mockRestore();
});

test('Responses converts only new citations after indexed text keeps streaming', async () => {
  const first = citation(0, 2);
  const second = citation(2, 4);
  const source = [
    chunk({ content: 'A😀' }),
    chunk({ annotations: [first] }),
    chunk({ content: '中B' }),
    chunk({ annotations: [first, second] }, { finish_reason: 'stop' }),
    doneFrame(),
  ];
  const frames = await collect(openaiResponsesFromIR(irFromOpenAIChatCompletions(iterate(source))));
  const annotations = frames.flatMap(frame => frame.type === 'event' && frame.event.type === 'response.output_text.annotation.added' ? [frame.event] : []);
  expect(annotations.map(event => event.annotation_index)).toEqual([0, 1]);
  expect(annotations.map(event => event.annotation)).toEqual([
    { type: 'url_citation', url: 'https://example.com', title: 'Source', start_index: 0, end_index: 2 },
    { type: 'url_citation', url: 'https://example.com', title: 'Source', start_index: 2, end_index: 4 },
  ]);
});

test('late ChatCompletions citations on closed text are dropped', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const source = [chunk({ content: 'A😀' }), chunk({ reasoning_text: 'R' }), chunk({ content: '中B' }), chunk({ reasoning_text: 'tail' }), chunk({ annotations: [citation(1, 3)] }, { finish_reason: 'stop' }), doneFrame()];
  const ir = await collectIR(irFromOpenAIChatCompletions(iterate(source)));
  expect(ir.choices[0].items.filter(item => item.type === 'message').every(item => item.content.every(part => part.type !== 'text' || part.annotations === undefined))).toBe(true);
  expect(warning).toHaveBeenCalledWith('Dropping ChatCompletions citation outside open text', expect.objectContaining({ choice: 0 }));
  warning.mockRestore();
});

test('ChatCompletions rejects a reversed citation before clamping it to available text', async () => {
  const source = [chunk({ content: 'abc' }), chunk({ annotations: [citation(5, 3)] }, { finish_reason: 'stop' }), doneFrame()];
  await expect(collectIR(irFromOpenAIChatCompletions(iterate(source)))).rejects.toThrow('Invalid code-point range');
});

test('Messages cited text remains source text without inventing output coordinates', async () => {
  const ir = await collectIR(irFromAnthropicMessages(iterate(messagesCitationFrames('source quote'))));
  const item = ir.choices[0].items[0];
  if (item.type !== 'message' || item.content[0].type !== 'text') throw new Error('expected cited text part');
  expect(item.content[0].annotations?.[0]).toMatchObject({ source_text: 'source quote' });
  expect(item.content[0].annotations?.[0]).not.toHaveProperty('output_text_range');

  const result = await nativeResult('openai-responses', await collect(openaiResponsesFromIR(irFromAnthropicMessages(iterate(messagesCitationFrames('source quote'))))));
  expect(result.output[0].content[0].annotations).toEqual([]);
});

test('Messages URL citations without cited text do not expand to the entire Responses text', async () => {
  const ir = await collectIR(irFromAnthropicMessages(iterate(messagesCitationFrames())));
  const item = ir.choices[0].items[0];
  expect(item).toMatchObject({ content: [{ annotations: [{ source: 'https://docs.example.com/page-1' }] }] });
  if (item.type !== 'message' || item.content[0].type !== 'text') throw new Error('expected cited text part');
  expect(item.content[0].annotations?.[0]).not.toHaveProperty('output_text_range');
  const result = await nativeResult('openai-responses', await collect(openaiResponsesFromIR(irFromAnthropicMessages(iterate(messagesCitationFrames())))));
  expect(result.output[0].content[0].annotations).toEqual([]);
});

test('range-less Messages citations do not expand to whole-part ChatCompletions or GenerateContent citations', async () => {
  const chatFrames = await collect(openaiChatCompletionsFromIR(irFromAnthropicMessages(iterate(messagesCitationFrames('source quote'))), { id: 'chat_target', created: 1 }));
  expect(chatFrames.some(frame => frame.type === 'event' && !('error' in frame.event) && frame.event.choices.some(choice => 'annotations' in choice.delta))).toBe(false);

  const generateContentFrames = await collect(geminiGenerateContentFromIR(irFromAnthropicMessages(iterate(messagesCitationFrames('source quote')))));
  expect(generateContentFrames.some(frame => frame.type === 'event' && 'candidates' in frame.event && frame.event.candidates?.some(candidate => candidate.groundingMetadata !== undefined))).toBe(false);
});
