import { describe, expect, it } from 'vitest';

import { codePointRangeToIR, irRangeToCodePoints } from '../coordinates.ts';
import { irFromAnthropicMessages } from '../from-anthropic-messages.ts';
import { irFromOpenAIChatCompletions } from '../from-openai-chat-completions.ts';
import { irFromOpenAIResponses } from '../from-openai-responses.ts';
import type { IR } from '../ir.ts';
import { collectIR, createIRBuilder } from '../stream.ts';
import { anthropicMessagesFromIR } from '../to-anthropic-messages.ts';
import { geminiGenerateContentFromIR } from '../to-gemini-generate-content.ts';
import { openaiChatCompletionsFromIR } from '../to-openai-chat-completions.ts';
import { openaiResponsesFromIR } from '../to-openai-responses.ts';
import { collect, completeIR, events, iterate } from './helpers.ts';
import { reassembleAnthropicMessagesEvents, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { reassembleGeminiGenerateContentEvents } from '@floway-dev/protocols/gemini-generate-content';
import { reassembleOpenAIChatCompletionsEvents, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { openaiResponsesResultToEvents, reassembleOpenAIResponsesEvents, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const options = { id: 'target', model: 'model', created: 1 };
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
      expect(frames.at(-1)?.type).toBe('done');
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

  it('preserves temporal interleaving and projection ranges when ChatCompletions flattens items', async () => {
    const b = createIRBuilder(); b.event({ type: 'start', id: 's', model: 'm' });
    b.item(0, { type: 'message', content: [{ type: 'text', text: 'a' }] }); const first = b.drain();
    b.item(0, { type: 'message', content: [{ type: 'text', text: 'b' }] }); const second = b.drain();
    b.append(['choices', 0, 'items', 0, 'content', 0, 'text'], 'c');
    b.event({ type: 'choice_end', choice: 0, finish_reason: 'stop' }); b.event({ type: 'finish', status: 'completed' });
    let projection: any;
    const result = await reassembleOpenAIChatCompletionsEvents(events(openaiChatCompletionsFromIR(iterate([first, second, b.drain()]), { ...options, onProjection: value => { projection = value; } })));
    expect(result.choices[0].message.content).toBe('abc');
    expect(projection.projections.filter((p: any) => p.source_path[3] === 0).map((p: any) => [p.target_start, p.target_end_exclusive])).toEqual([[0, 1], [2, 3]]);
  });

  it('rejects missing terminals and unsafe replacement on an append-only downstream', async () => {
    await expect(collectIR(irFromOpenAIChatCompletions(iterate([chatFrame([{ index: 0, delta: { content: 'x' } }])])))).rejects.toThrow('without done');
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
});
