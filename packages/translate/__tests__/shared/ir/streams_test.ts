import { describe, expect, it } from 'vitest';

import { collectIR, collect, completeIR, events, iterate } from './helpers.ts';
import { codePointRangeToIR, irRangeToCodePoints } from '../../../src/shared/ir/shared/coordinates.ts';
import type { IR } from '../../../src/shared/ir/ir.ts';
import { createIRProjection } from '../../../src/shared/ir/shared/projection.ts';
import { irFromAnthropicMessages } from '../../../src/shared/ir/sse-from/anthropic-messages/index.ts';
import { irFromOpenAIChatCompletions } from '../../../src/shared/ir/sse-from/openai-chat-completions/index.ts';
import { irFromOpenAIResponses, responsesItemToIR } from '../../../src/shared/ir/sse-from/openai-responses/index.ts';
import { anthropicMessagesFromIR } from '../../../src/shared/ir/sse-to/anthropic-messages/index.ts';
import { geminiGenerateContentFromIR } from '../../../src/shared/ir/sse-to/gemini-generatecontent/index.ts';
import { openaiChatCompletionsFromIR } from '../../../src/shared/ir/sse-to/openai-chat-completions/index.ts';
import { openaiResponsesFromIR } from '../../../src/shared/ir/sse-to/openai-responses/index.ts';
import { usageFromIR, usageToIR } from '../../../src/shared/ir/shared/usage.ts';
import { reassembleAnthropicMessagesEvents, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { reassembleGeminiGenerateContentEvents } from '@floway-dev/protocols/gemini-generate-content';
import { reassembleOpenAIChatCompletionsEvents, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { openaiResponsesResultToEvents, reassembleOpenAIResponsesEvents, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const options = { id: 'target', created: 1 };
const chatFrame = (choices: any[], usage?: any) => eventFrame({ id: 'source', object: 'chat.completion.chunk', model: 'model', created: 1, choices, ...(usage === undefined ? {} : { usage }) } as OpenAIChatCompletionsStreamEvent);
const chat = () => irFromOpenAIChatCompletions(iterate([
  chatFrame([{ index: 0, delta: { reasoning_text: 'think' } }]),
  chatFrame([{ index: 0, delta: { content: 'A😀' } }]),
  chatFrame([{ index: 0, delta: { content: '中B', annotations: [{ type: 'url_citation', url_citation: { start_index: 1, end_index: 3, url: 'https://example.com', title: 'Source' } }] } }]),
  chatFrame([{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'tool', arguments: '{"a":' } }] } }]),
  chatFrame([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }]),
  chatFrame([], { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } }), doneFrame(),
]));
const responses = () => irFromOpenAIResponses(iterate([...openaiResponsesResultToEvents({
  id: 'source', object: 'response', model: 'model', status: 'completed', error: null, incomplete_details: null,
  output: [
    { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'th' }, { type: 'summary_text', text: 'ink' }], content: [{ type: 'reasoning_text', text: 'detail' }], encrypted_content: 'sealed' },
    { type: 'message', id: 'm', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'A😀', annotations: [] }, { type: 'output_text', text: '中B', annotations: [] }] },
    { type: 'function_call', id: 'f', call_id: 'call', name: 'tool', arguments: '{"a":1}', status: 'completed' },
  ], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } },
} as OpenAIResponsesResultEx), doneFrame()]));
const messages = () => irFromAnthropicMessages(iterate([
  { type: 'message_start', message: { id: 'source', type: 'message', role: 'assistant', model: 'model', content: [], usage: { input_tokens: 6, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'old' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sealed' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'A😀', citations: [] } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '中B' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call', name: 'tool', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '1}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
].map(value => eventFrame(value as AnthropicMessagesStreamEventEx))));

describe('fit IR streaming', () => {
  it.each([['ChatCompletions', chat], ['Responses', responses], ['Messages', messages]] as const)('normalizes %s without flattening source strings', async (_name, source) => {
    const value = await collectIR(source());
    expect(value.usage?.input_tokens_inclusive).toBe(11);
    expect(value.usage?.output_tokens_inclusive).toBe(7);
    const reasoning = value.choices[0].items.find(item => item.type === 'reasoning');
    expect(reasoning?.type).toBe('reasoning');
    if (_name === 'Responses' && reasoning?.type === 'reasoning') expect(reasoning.summary).toEqual(['th', 'ink']);
    if (_name === 'Messages' && reasoning?.type === 'reasoning') expect(reasoning.encrypted_content).toBe('sealed');
  });

  for (const [name, source] of [['ChatCompletions', chat], ['Responses', responses], ['Messages', messages]] as const) {
    it(`ChatCompletions via ${name} emits text and streamed function arguments`, async () => {
      const result = await reassembleOpenAIChatCompletionsEvents(events(openaiChatCompletionsFromIR(source(), options)));
      expect(result.choices[0].message.content).toBe('A😀中B');
      expect(result.choices[0].message.tool_calls?.[0]).toMatchObject({ type: 'function', function: { name: 'tool', arguments: '{"a":1}' } });
      expect(result.usage?.prompt_tokens).toBe(11);
    });
    it(`Responses via ${name} completes item lifecycles`, async () => {
      const frames = await collect(openaiResponsesFromIR(source(), options));
      const result = await reassembleOpenAIResponsesEvents(events(iterate(frames)));
      expect(result.output.filter(item => item.type === 'message').flatMap(item => item.type === 'message' ? item.content.map(p => p.type === 'output_text' ? p.text : '') : []).join('')).toBe('A😀中B');
      expect(result.output.find(item => item.type === 'function_call')).toMatchObject({ name: 'tool', arguments: '{"a":1}' });
      const sequence = frames.flatMap(frame => frame.type === 'event' ? [frame.event.sequence_number!] : []);
      expect(sequence).toEqual(sequence.map((_, index) => index));
      expect(frames.at(-1)?.type).toBe('event');
    });
    it(`Messages via ${name} serializes blocks and parses tool input`, async () => {
      const result = await reassembleAnthropicMessagesEvents(events(anthropicMessagesFromIR(source(), options)));
      expect(result.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('')).toBe('A😀中B');
      expect(result.content.find(block => block.type === 'tool_use')).toMatchObject({ name: 'tool', input: { a: 1 } });
      expect(result.usage.output_tokens).toBe(7);
    });
    it(`GenerateContent via ${name} emits complete object args and final usage`, async () => {
      const frames = await collect(geminiGenerateContentFromIR(source(), options));
      const result = await reassembleGeminiGenerateContentEvents(events(iterate(frames)));
      expect(result.candidates?.[0].content?.parts?.filter(p => p.text !== undefined && !p.thought).map(p => p.text).join('')).toBe('A😀中B');
      expect(result.candidates?.[0].content?.parts?.find(p => p.functionCall !== undefined)?.functionCall).toMatchObject({ name: 'tool', args: { a: 1 } });
      expect(result.usageMetadata?.promptTokenCount).toBe(11);
      const last = frames.at(-1); expect(last?.type === 'event' && !('error' in last.event) && last.event.candidates?.[0].finishReason).toBe('STOP');
    });
  }

  it('preserves Unicode citation units and excludes the end', async () => {
    const value = await collectIR(chat());
    const item = value.choices[0].items.find(i => i.type === 'message');
    expect(item?.type === 'message' && item.content[0].type === 'text' && item.content[0].annotations?.[0].output_text_range).toEqual({ start: 1, end_exclusive: 4 });
    expect(codePointRangeToIR('A😀中B', 1, 3)).toEqual({ start: 1, end_exclusive: 4 });
    expect(irRangeToCodePoints('A😀中B', { start: 1, end_exclusive: 4 })).toEqual({ start: 1, end: 3 });
    expect(() => irRangeToCodePoints('A😀中B', { start: 2, end_exclusive: 4 })).toThrow();
  });

  it('delivers text before pulling the upstream completion', async () => {
    let exhausted = false;
    const upstream = async function* () {
      yield chatFrame([{ index: 0, delta: { content: 'first' } }]);
      exhausted = true;
      yield chatFrame([{ index: 0, delta: {}, finish_reason: 'stop' }]); yield doneFrame();
    };
    const stream = openaiChatCompletionsFromIR(irFromOpenAIChatCompletions(upstream()), options);
    let found = false;
    for await (const frame of stream) if (frame.type === 'event' && frame.event.choices[0]?.delta.content === 'first') {
      expect(exhausted).toBe(false); found = true; break;
    }
    expect(found).toBe(true);
  });

  it('rejects missing terminals and unsafe replacement on an append-only downstream', async () => {
    await expect(collectIR(irFromOpenAIChatCompletions(iterate([chatFrame([{ index: 0, delta: { content: 'x' } }])])))).rejects.toThrow('without finish_reason');
    const frames = completeIR([{ type: 'message', content: [{ type: 'text', text: 'a' }] }]);
    frames[0].records.splice(2, 0, { type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'b' });
    await expect(collect(openaiChatCompletionsFromIR(iterate(frames), options))).rejects.toThrow('cannot replace');
  });

  it('handles Responses terminal-only output and implicit audio events', async () => {
    const result: OpenAIResponsesResultEx = { id: 's', object: 'response', model: 'm', status: 'completed', output: [], error: null, incomplete_details: null };
    const source = irFromOpenAIResponses(iterate([
      eventFrame({ type: 'response.created', response: result } as OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.audio.delta', delta: 'YWJj' } as OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.audio.transcript.delta', delta: 'abc' } as OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.audio.done' } as OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.audio.transcript.done' } as OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.completed', response: result } as OpenAIResponsesStreamEventEx), doneFrame(),
    ]));
    const ir = await collectIR(source);
    expect(ir.choices[0].items[0]).toMatchObject({ type: 'message', content: [{ type: 'audio', audio: { data: 'YWJj', transcript: 'abc' } }] });
    const out = await collect(events(openaiResponsesFromIR(iterate(completeIR(ir.choices[0].items)), options)));
    expect(out).toContainEqual(expect.objectContaining({ type: 'response.audio.delta', delta: 'YWJj' }));
  });

  it('keeps multi-choice candidate ends with the final usage', async () => {
    const state: IR = { choices: [{ items: [{ type: 'message', content: [{ type: 'text', text: 'a' }] }] }, { items: [{ type: 'message', content: [{ type: 'text', text: 'b' }] }] }], usage: { input_tokens_inclusive: 3 } };
    const frames: any = [{ records: [{ type: 'start', id: 's', model: 'm' }, { type: 'operation', operation: 'assign', path: ['choices'], value: state.choices }, { type: 'operation', operation: 'assign', path: ['usage'], value: state.usage }, { type: 'choice_end', choice: 0, finish_reason: 'stop' }, { type: 'choice_end', choice: 1, finish_reason: 'length' }, { type: 'finish', status: 'completed' }] }];
    const result = await collect(events(geminiGenerateContentFromIR(iterate(frames), options)));
    const final = result.at(-1)!;
    expect('error' in final).toBe(false);
    if ('error' in final) throw new Error('Unexpected GenerateContent error');
    expect(final.candidates?.map(c => c.finishReason)).toEqual(['STOP', 'MAX_TOKENS']);
    expect(final.usageMetadata?.promptTokenCount).toBe(3);
  });

  it('merges projection spans split inside a surrogate pair', () => {
    const projection = createIRProjection();
    projection.append(['text'], '\ud83d', ['content']);
    projection.append(['text'], '😀', ['content']);
    expect(projection.result().projections).toMatchObject([{ source_start: 0, source_end_exclusive: 2, target_start: 0, target_end_exclusive: 2 }]);
    expect(projection.result().projections).toHaveLength(1);
  });

  it('preserves thinking and cache-write usage details', () => {
    expect(usageFromIR(usageToIR('anthropicMessages', { input_tokens: 2, output_tokens: 3, output_tokens_details: { thinking_tokens: 1 } }), 'anthropicMessages')).toMatchObject({ output_tokens_details: { thinking_tokens: 1 } });
    expect(usageFromIR(usageToIR('openaiResponses', { input_tokens: 2, output_tokens: 3, input_tokens_details: { cache_write_tokens: 1 } }), 'openaiResponses')).toMatchObject({ input_tokens_details: { cache_write_tokens: 1 } });
  });

  it('preserves ChatCompletions audio replay metadata across deltas', async () => {
    const frames = [chatFrame([{ index: 0, delta: { audio: { id: 'audio', expires_at: 123, data: 'YQ==' } } }]), chatFrame([{ index: 0, delta: { audio: { transcript: 'word' } } }]), chatFrame([{ index: 0, delta: {}, finish_reason: 'stop' }]), doneFrame()];
    const result = await reassembleOpenAIChatCompletionsEvents(events(openaiChatCompletionsFromIR(irFromOpenAIChatCompletions(iterate(frames)), options)));
    expect(result.choices[0].message.audio).toEqual({ id: 'audio', expires_at: 123, data: 'YQ==', transcript: 'word' });
  });

  it('retains text-image-text order in Responses output', async () => {
    const frames = openaiResponsesFromIR(iterate(completeIR([{ type: 'message', content: [{ type: 'text', text: 'before' }, { type: 'image', image: { data: 'YQ==', mime_type: 'image/png' } }, { type: 'text', text: 'after' }] }])), options);
    const result = await reassembleOpenAIResponsesEvents(events(frames));
    expect(result.output.map(item => item.type)).toEqual(['message', 'image_generation_call', 'message']);
  });

  it('marks ChatCompletions length termination incomplete and exposes failed IR', async () => {
    const frames = await collect(irFromOpenAIChatCompletions(iterate([chatFrame([{ index: 0, delta: { content: 'text' }, finish_reason: 'length' }]), doneFrame()])));
    expect(frames.flatMap(frame => frame.records).find(record => record.type === 'finish')).toMatchObject({ status: 'incomplete' });
    await expect(collectIR(iterate([{ records: [{ type: 'start', id: 's', model: 'm' }, { type: 'finish', status: 'failed', error: { message: 'failure' } }] }]))).rejects.toThrow();
  });

  it.each([true, false])('buffers later Responses text behind a pending image (success=%s)', async success => {
    const image: any = { type: 'image_generation_call', id: 'img', status: 'in_progress', result: null };
    const message: any = { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'later', annotations: [null] }] };
    const resultImage = { ...image, status: success ? 'completed' : 'failed', result: success ? 'YQ==' : null };
    const response: any = { id: 's', model: 'm', output: [resultImage, message], usage: null };
    const input: any[] = [{ type: 'response.created', response: { ...response, output: [] } }, { type: 'response.output_item.added', output_index: 0, item: image }, { type: 'response.output_item.added', output_index: 1, item: message }, { type: 'response.output_item.done', output_index: 1, item: message }, { type: 'response.output_item.done', output_index: 0, item: resultImage }, { type: 'response.completed', response }];
    const frames = await collect(irFromOpenAIResponses(iterate(input.map(eventFrame))));
    const ir = await collectIR(iterate(frames));
    const parts = ir.choices[0].items.flatMap(item => item.type === 'message' ? item.content : []);
    expect(parts.map(part => part.type)).toEqual(success ? ['image', 'text'] : ['text']);
    expect(frames.flatMap(frame => frame.records).filter(record => record.type === 'part_end')).toHaveLength(success ? 2 : 1);
  });

  it('closes a Responses text part before its item finishes', async () => {
    const input: any[] = [{ type: 'response.created', response: { id: 's', model: 'm', output: [] } }, { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg', role: 'assistant', content: [] } }, { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'text', annotations: [] } }, { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'text', annotations: [] } }];
    const iterator = irFromOpenAIResponses(iterate(input.map(eventFrame)));
    const frames = [];
    for (const _event of input) frames.push((await iterator.next()).value!);
    expect(frames.at(-1)?.records).toContainEqual({ type: 'part_end', choice: 0, item: 0, part: 0 });
    expect(frames.flatMap(frame => frame.records).some(record => record.type === 'item_end')).toBe(false);
    await iterator.return(undefined);
  });

  it.each([['Messages', anthropicMessagesFromIR, reassembleAnthropicMessagesEvents], ['GenerateContent', geminiGenerateContentFromIR, reassembleGeminiGenerateContentEvents]] as const)('allows configured JSON repair in %s while exposing default parse failures', async (_name, adapter, reassemble) => {
    const frames = completeIR([{ type: 'function_call', name: 'tool', call_id: 'c', arguments: '{"a":1' }]);
    const output = adapter(iterate(frames), { ...options, parseToolArguments: text => JSON.parse(`${text}}`) });
    const result: any = await (reassemble as any)(events<unknown>(output));
    expect(_name === 'Messages' ? result.content.find((block: any) => block.type === 'tool_use').input : result.candidates[0].content.parts.find((part: any) => part.functionCall).functionCall.args).toEqual({ a: 1 });
    await expect((reassemble as any)(events<unknown>(adapter(iterate(frames), options)))).rejects.toThrow();
  });

  it('waits for function names before Responses item creation', async () => {
    const frames = await collect(openaiResponsesFromIR(chat(), options));
    const added = frames.flatMap(frame => frame.type === 'event' && frame.event.type === 'response.output_item.added' && frame.event.item.type === 'function_call' ? [frame.event.item] : []);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ name: 'tool', call_id: 'call' });
  });

  it.each([{ items: [] }, { items: [{ type: 'reasoning', content: ['thought'] }] }])('exposes invalid logprob item ownership %j', async ({ items }) => {
    const frames = completeIR(items);
    frames[0].records.splice(2, 0, { type: 'operation', operation: 'assign', path: ['choices', 0, 'logprobs'], value: [{ scope: 'text_part', item_index: 0, content_index: 0, tokens: [{ token: 'x', logprob: -1 }] }] });
    await expect(collect(openaiChatCompletionsFromIR(iterate(frames), options))).rejects.toThrow();
  });

  it('uses the same lifecycle validation when collecting IR', async () => {
    for (const records of [[{ type: 'finish', status: 'completed' }], [{ type: 'start', id: 's', model: 'm' }, { type: 'start', id: 's', model: 'm' }, { type: 'finish', status: 'completed' }]]) {
      await expect(collectIR(iterate([{ records } as any]))).rejects.toThrow();
    }
  });

  it('preserves Responses generated image format', async () => {
    const result = await reassembleOpenAIResponsesEvents(events(openaiResponsesFromIR(iterate(completeIR([{ type: 'message', content: [{ type: 'image', image: { data: 'YQ==', mime_type: 'image/jpeg' } }] }])), options)));
    expect(result.output[0]).toMatchObject({ type: 'image_generation_call', output_format: 'jpeg' });
  });

  it('does not invent MIME types for a null Responses format', () => {
    expect(responsesItemToIR({ type: 'image_generation_call', result: 'YQ==', output_format: null })).toEqual({ type: 'message', content: [{ type: 'image', image: { data: 'YQ==' } }] });
  });

  it.each([true, false])('preserves Responses audio when transcript arrives first=%s', async transcriptFirst => {
    const data = { type: 'response.audio.delta', delta: 'YQ==' };
    const transcript = { type: 'response.audio.transcript.delta', delta: 'hello' };
    const response = { id: 's', model: 'm', output: [] };
    const input: any[] = [{ type: 'response.created', response }, ...(transcriptFirst ? [transcript, data] : [data, transcript]), { type: 'response.audio.done' }, { type: 'response.audio.transcript.done' }, { type: 'response.completed', response }];
    const source = () => irFromOpenAIResponses(iterate(input.map(eventFrame)));
    const messages = await reassembleAnthropicMessagesEvents(events(anthropicMessagesFromIR(source(), options)));
    expect(messages.content).toMatchObject([{ type: 'text', text: 'hello' }]);
    const chat = await reassembleOpenAIChatCompletionsEvents(events(openaiChatCompletionsFromIR(source(), { ...options, audioMetadata: () => ({ id: 'a', expires_at: 123 }) })));
    expect(chat.choices[0].message.audio).toEqual({ id: 'a', expires_at: 123, data: 'YQ==', transcript: 'hello' });
    expect(chat.choices[0].message.content).toBeNull();
  });

  it('emits transcript-only audio before ChatCompletions finish_reason', async () => {
    const frames = await collect(openaiChatCompletionsFromIR(iterate(completeIR([{ type: 'message', content: [{ type: 'audio', audio: { transcript: 'hello' } }] }])), options));
    const chunks = frames.flatMap(frame => frame.type === 'event' ? frame.event.choices : []);
    expect(chunks.findIndex(choice => choice.delta.content === 'hello')).toBeLessThan(chunks.findIndex(choice => choice.finish_reason === 'stop'));
  });

  it.each([['Responses', openaiResponsesFromIR], ['Messages', anthropicMessagesFromIR]] as const)('rejects completed unnamed tools in %s', async (_name, adapter) => {
    await expect(collect<unknown>(adapter(iterate(completeIR([{ type: 'function_call', name: '', arguments: '{}' }])), options))).rejects.toThrow('require a name');
  });

});
