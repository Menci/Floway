import { describe, expect, it } from 'vitest';

import { anthropicMessagesFromIR, collectIR, collect, completeIR, events, geminiGenerateContentFromIR, irFromAnthropicMessages, irFromOpenAIChatCompletions, irFromOpenAIResponses, iterate, openaiChatCompletionsFromIR, openaiResponsesFromIR } from './helpers.ts';
import { createIRBuilder } from '../../src/ir/stream.ts';
import type { IRItem, IRJSONObject } from '../../src/ir/types.ts';
import { usageFromIR as messagesUsageFromIR } from '../../src/protocols/anthropic-messages/as-source/usage.ts';
import { usageToIR as messagesUsageToIR } from '../../src/protocols/anthropic-messages/as-target/usage.ts';
import { usageFromIR as responsesUsageFromIR } from '../../src/protocols/openai-responses/as-source/usage.ts';
import { usageToIR as responsesUsageToIR } from '../../src/protocols/openai-responses/as-target/usage.ts';
import { TextCoordinateIndex } from '../../src/shared/text-coordinate-index.ts';
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
const responseFrames = () => iterate([...openaiResponsesResultToEvents({
  id: 'source', object: 'response', model: 'model', status: 'completed', error: null, incomplete_details: null,
  output: [
    { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'th' }, { type: 'summary_text', text: 'ink' }], content: [{ type: 'reasoning_text', text: 'detail' }], encrypted_content: 'sealed' },
    { type: 'message', id: 'm', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'A😀', annotations: [] }, { type: 'output_text', text: '中B', annotations: [] }] },
    { type: 'function_call', id: 'f', call_id: 'call', name: 'tool', arguments: '{"a":1}', status: 'completed' },
  ], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } },
} as OpenAIResponsesResultEx), doneFrame()]);
const responses = () => irFromOpenAIResponses(responseFrames());
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

const translateChatFrames = async (nativeFrames: readonly any[]) => {
  const irFrames = await collect(irFromOpenAIChatCompletions(iterate(nativeFrames as any[])));
  const chatFrames = await collect(openaiChatCompletionsFromIR(iterate(irFrames)));
  const responsesFrames = await collect(openaiResponsesFromIR(iterate(irFrames)));
  const messagesFrames = await collect(anthropicMessagesFromIR(iterate(irFrames)));
  const generateContentFrames = await collect(geminiGenerateContentFromIR(iterate(irFrames)));
  return {
    irFrames,
    chatFrames,
    chat: await reassembleOpenAIChatCompletionsEvents(events(iterate(chatFrames))),
    responsesFrames,
    responses: await reassembleOpenAIResponsesEvents(events(iterate(responsesFrames))),
    messagesFrames,
    messages: await reassembleAnthropicMessagesEvents(events(iterate(messagesFrames))),
    generateContentFrames,
    generateContent: await reassembleGeminiGenerateContentEvents(events(iterate(generateContentFrames))),
  };
};

describe('IR streaming', () => {
  it.each([['ChatCompletions', chat], ['Responses', responses], ['Messages', messages]] as const)('normalizes %s without flattening source strings', async (_name, source) => {
    const value = await collectIR(source());
    expect(value.usage?.input_tokens_inclusive).toBe(11);
    expect(value.usage?.output_tokens_inclusive).toBe(7);
    const reasoning = value.choices[0].items.find(item => item.type === 'reasoning');
    expect(reasoning?.type).toBe('reasoning');
    if (_name === 'Responses') {
      if (reasoning?.type === 'reasoning') expect(reasoning.summary).toEqual(['th', 'ink']);
      expect(value.choices[0].items.find(item => item.type === 'message')).toMatchObject({
        type: 'message', content: [{ type: 'text', text: 'A😀' }, { type: 'text', text: '中B' }],
      });
    }
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
      if (name === 'Responses') {
        const message = result.output.find(item => item.type === 'message');
        expect(message?.type === 'message' && message.content).toEqual([
          { type: 'output_text', text: 'A😀', annotations: [], logprobs: [] },
          { type: 'output_text', text: '中B', annotations: [], logprobs: [] },
        ]);
      }
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
      expect(frames).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ candidates: [expect.objectContaining({ index: 0, finishReason: 'STOP' })] }) }));
      expect(frames.at(-1)).toMatchObject({ event: { usageMetadata: { promptTokenCount: 11 } } });
    });
  }

  it('translates raw Azure annotation frames into every target without carrying filter metadata', async () => {
    const translated = await translateChatFrames([
      eventFrame({ id: '', object: '', created: 0, model: '', prompt_filter_results: [{ prompt_index: 0 }], choices: [], usage: null } as any),
      eventFrame({ id: 'chatcmpl-azure', object: 'chat.completion.chunk', created: 10, model: 'azure-model', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] } as any),
      eventFrame({ id: 'chatcmpl-azure', object: 'chat.completion.chunk', created: 10, model: 'azure-model', choices: [{ index: 0, delta: { content: 'A' }, finish_reason: null }] } as any),
      eventFrame({ id: '', object: '', created: 0, model: '', choices: [{ index: 0, finish_reason: null, content_filter_results: { hate: { filtered: false } }, content_filter_offsets: { check_offset: 1, start_offset: 1, end_offset: 1 } }], usage: null } as any),
      eventFrame({ id: '', object: '', created: 0, model: '', choices: [{ index: 0, delta: {}, finish_reason: null, content_filter_results: { hate: { filtered: false } } }], usage: null } as any),
      eventFrame({ id: 'chatcmpl-azure', object: 'chat.completion.chunk', created: 10, model: 'azure-model', choices: [{ index: 0, delta: { content: 'B' }, finish_reason: null }] } as any),
      eventFrame({ id: 'chatcmpl-azure', object: 'chat.completion.chunk', created: 10, model: 'azure-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as any),
      eventFrame({ id: '', object: '', created: 0, model: '', choices: [{ index: 0, delta: null, finish_reason: null, content_filter_results: { hate: { filtered: false } } }], usage: null } as any),
      eventFrame({ id: '', object: '', created: 0, model: '', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } as any),
      doneFrame(),
    ]);
    const start = translated.irFrames.find(record => record.type === 'start');

    expect(start).toEqual({ type: 'start', id: 'chatcmpl-azure', created: 10 });
    expect(translated.chat.choices[0]?.message.content).toBe('AB');
    expect(translated.responses.output.filter(item => item.type === 'message').flatMap(item => item.type === 'message' ? item.content.map(part => part.type === 'output_text' ? part.text : '') : []).join('')).toBe('AB');
    expect(translated.messages.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('')).toBe('AB');
    expect(translated.generateContent.candidates?.[0]?.content?.parts?.filter(part => part.text !== undefined && !part.thought).map(part => part.text).join('')).toBe('AB');

    const chatStart = translated.chatFrames.find(frame => frame.type === 'event');
    expect(chatStart?.type === 'event' && !('error' in chatStart.event) && chatStart.event.id).toBe('chatcmpl-azure');
    const responseStart = translated.responsesFrames.find(frame => frame.type === 'event' && frame.event.type === 'response.created');
    if (responseStart?.type !== 'event' || responseStart.event.type !== 'response.created') throw new Error('Expected a Responses opening event');
    expect(responseStart.event.response.id).toMatch(/^resp_/);
    expect(responseStart.event.response.created_at).toBe(10);
  });

  it('translates raw Copilot frames with a generated target ID and a fixed start timestamp', async () => {
    const translated = await translateChatFrames([
      eventFrame({ id: '', created: 0, model: '', prompt_filter_results: [{ prompt_index: 0 }], choices: [], usage: null } as any),
      eventFrame({ created: 20, model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] } as any),
      eventFrame({ created: 21, model: 'gpt-4o', choices: [{ index: 0, delta: { content: 'A' }, finish_reason: null }] } as any),
      eventFrame({ id: 'chatcmpl-late', created: 22, model: 'gpt-4o', choices: [{ index: 0, delta: { content: 'B' }, finish_reason: null }] } as any),
      eventFrame({ id: 'chatcmpl-late', created: 23, model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as any),
      eventFrame({ id: 'chatcmpl-late', created: 24, model: 'gpt-4o', choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } } as any),
      doneFrame(),
    ]);
    const start = translated.irFrames.find(record => record.type === 'start');

    expect(start).toEqual({ type: 'start', created: 20 });
    expect(translated.chat.choices[0]?.message.content).toBe('AB');
    expect(translated.responses.output.filter(item => item.type === 'message').flatMap(item => item.type === 'message' ? item.content.map(part => part.type === 'output_text' ? part.text : '') : []).join('')).toBe('AB');
    expect(translated.messages.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('')).toBe('AB');
    expect(translated.generateContent.candidates?.[0]?.content?.parts?.filter(part => part.text !== undefined && !part.thought).map(part => part.text).join('')).toBe('AB');

    const chatStart = translated.chatFrames.find(frame => frame.type === 'event');
    expect(chatStart?.type === 'event' && !('error' in chatStart.event) && chatStart.event.id).toMatch(/^chatcmpl-/);
    const chatEvents = translated.chatFrames.filter(frame => frame.type === 'event' && !('error' in frame.event));
    expect(chatEvents.length).toBeGreaterThan(0);
    expect(chatEvents.every(frame => frame.type === 'event' && !('error' in frame.event) && frame.event.created === 20)).toBe(true);
    const responseStart = translated.responsesFrames.find(frame => frame.type === 'event' && frame.event.type === 'response.created');
    if (responseStart?.type !== 'event' || responseStart.event.type !== 'response.created') throw new Error('Expected a Responses opening event');
    expect(responseStart.event.response.id).toMatch(/^resp_/);
    expect(responseStart.event.response.created_at).toBe(20);
    const messagesStart = translated.messagesFrames.find(frame => frame.type === 'event');
    expect(messagesStart?.type === 'event' && messagesStart.event.type === 'message_start' && messagesStart.event.message.id).toMatch(/^msg_/);
    expect(translated.generateContentFrames.some(frame => frame.type === 'event' && 'responseId' in frame.event && frame.event.responseId !== undefined)).toBe(true);
  });

  it('preserves Unicode citation units and excludes the end', async () => {
    const value = await collectIR(chat());
    const item = value.choices[0].items.find(i => i.type === 'message');
    expect(item?.type === 'message' && item.content[0].type === 'text' && item.content[0].annotations?.[0].output_text_range).toEqual({ start: 1, end_exclusive: 4 });
    expect(TextCoordinateIndex.codePointsToUTF16('A😀中B').codePointRangeToIR(1, 3)).toEqual({ start: 1, end_exclusive: 4 });
    const index = TextCoordinateIndex.utf16ToCodePoints('A😀中B');
    expect(index.irRangeToCodePoints({ start: 1, end_exclusive: 4 })).toEqual({ start: 1, end: 3 });
    expect(() => index.irRangeToCodePoints({ start: 2, end_exclusive: 4 })).toThrow();
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
    for await (const frame of stream) if (frame.type === 'event' && !('error' in frame.event) && frame.event.choices[0]?.delta.content === 'first') {
      expect(exhausted).toBe(false); found = true; break;
    }
    expect(found).toBe(true);
  });

  it('rejects missing terminals and unsafe replacement on an append-only downstream', async () => {
    await expect(collectIR(irFromOpenAIChatCompletions(iterate([chatFrame([{ index: 0, delta: { content: 'x' } }])])))).rejects.toThrow('without finish_reason');
    const frames = completeIR([{ type: 'message', content: [{ type: 'text', text: 'a' }] }]);
    const part = frames.findIndex(record => record.type === 'write' && record.kind === 'initialize' && record.path.length === 6);
    frames.splice(part + 1, 0, { type: 'write', kind: 'assign', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'b' });
    await expect(collect(openaiChatCompletionsFromIR(iterate(frames), options))).rejects.toThrow('append target cannot be assigned');
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

  it('emits each candidate end before pulling the next choice or late final usage', async () => {
    const b = createIRBuilder(2);
    b.choice(0); b.choice(1); b.assign(['model'], 'm'); b.event({ type: 'start', id: 's' });
    let nextChoicePulled = false;
    let usagePulled = false;
    const source = async function* () {
      yield* b.drain();
      for (const [choice, text] of ['a', 'b'].entries()) {
        if (choice === 1) nextChoicePulled = true;
        b.initialize(['choices', choice, 'items', 0], { type: 'message', content: [] });
        b.initialize(['choices', choice, 'items', 0, 'content', 0], { type: 'text', text: '' });
        b.append(['choices', choice, 'items', 0, 'content', 0, 'text'], text);
        b.event({ type: 'part_end', choice, item: 0, part: 0 });
        b.event({ type: 'item_end', choice, item: 0 });
        b.event({ type: 'choice_end', choice, finish_reason: choice === 0 ? 'stop' : 'length' });
        yield* b.drain();
      }
      usagePulled = true;
      b.initialize(['usage'], { input_tokens_inclusive: 3 });
      b.event({ type: 'finish', status: 'completed' });
      yield* b.drain();
    };
    const output = events(geminiGenerateContentFromIR(source(), options));
    const result = [];
    for (const [choice, text] of ['a', 'b'].entries()) {
      const body = await output.next();
      expect(body).toMatchObject({ done: false, value: { candidates: [{ index: choice, content: { parts: [{ text }] } }] } });
      result.push(body.value);
      const sidecar = await output.next();
      expect(sidecar).toEqual({ done: false, value: { responseId: 'target', modelVersion: 'm', candidates: [{ index: choice, content: { role: 'model', parts: [{ thoughtSignature: 'test-sidecar' }] } }] } });
      result.push(sidecar.value);
      expect(nextChoicePulled).toBe(choice === 1);
      expect(usagePulled).toBe(false);
      const terminal = await output.next();
      expect(terminal).toEqual({ done: false, value: { responseId: 'target', modelVersion: 'm', candidates: [{ index: choice, finishReason: choice === 0 ? 'STOP' : 'MAX_TOKENS' }] } });
      result.push(terminal.value);
      expect(nextChoicePulled).toBe(choice === 1);
      expect(usagePulled).toBe(false);
    }
    const usage = await output.next();
    expect(usage).toEqual({ done: false, value: { responseId: 'target', modelVersion: 'm', usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 0, totalTokenCount: 3 } } });
    expect(usagePulled).toBe(true);
    result.push(usage.value);
    expect(await output.next()).toEqual({ done: true, value: undefined });
    expect(await reassembleGeminiGenerateContentEvents(iterate(result))).toEqual({
      responseId: 'target', modelVersion: 'm', usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 0, totalTokenCount: 3 },
      candidates: [
        { index: 0, content: { role: 'model', parts: [{ text: 'a' }, { thoughtSignature: 'test-sidecar' }] }, finishReason: 'STOP' },
        { index: 1, content: { role: 'model', parts: [{ text: 'b' }, { thoughtSignature: 'test-sidecar' }] }, finishReason: 'MAX_TOKENS' },
      ],
    });
  });

  it('ends at candidate termination without emitting an empty final frame when usage is absent', async () => {
    const frames = await collect(events(geminiGenerateContentFromIR(iterate(completeIR([{ type: 'message', content: [{ type: 'text', text: 'answer' }] }])), options)));
    expect(frames).toEqual([
      { responseId: 'target', modelVersion: 'model', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer' }] } }] },
      { responseId: 'target', modelVersion: 'model', candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'test-sidecar' }] } }] },
      { responseId: 'target', modelVersion: 'model', candidates: [{ index: 0, finishReason: 'STOP' }] },
    ]);
  });

  it('does not apply one choice termination to another choice tool', async () => {
    const b = createIRBuilder(2);
    b.choice(1);
    b.assign(['model'], 'm');
    b.event({ type: 'start', id: 's' });
    b.initialize(['choices', 1, 'items', 0], { type: 'function_call', name: 'tool', arguments: '' });
    b.append(['choices', 1, 'items', 0, 'arguments'], '{');
    b.event({ type: 'item_end', choice: 1, item: 0 });
    b.event({ type: 'choice_end', choice: 0, finish_reason: 'length' });
    b.event({ type: 'choice_end', choice: 1, finish_reason: 'stop' });
    b.event({ type: 'finish', status: 'incomplete' });
    await expect(collect(geminiGenerateContentFromIR(iterate(b.drain()), options))).rejects.toThrow();
  });

  it('preserves GenerateContent item order when a tool delays later text and audio', async () => {
    const b = createIRBuilder();
    b.choice(0);
    b.assign(['model'], 'm');
    b.event({ type: 'start', id: 's' });
    b.initialize(['choices', 0, 'items', 0], { type: 'function_call', call_id: 'call', name: 'tool', arguments: '' });
    b.append(['choices', 0, 'items', 0, 'arguments'], '{}');
    b.initialize(['choices', 0, 'items', 1], { type: 'message', content: [] });
    b.initialize(['choices', 0, 'items', 1, 'content', 0], { type: 'text', text: '' });
    b.append(['choices', 0, 'items', 1, 'content', 0, 'text'], 'after tool');
    b.event({ type: 'part_end', choice: 0, item: 1, part: 0 });
    b.event({ type: 'item_end', choice: 0, item: 1 });
    b.initialize(['choices', 0, 'items', 2], { type: 'message', content: [] });
    b.initialize(['choices', 0, 'items', 2, 'content', 0], { type: 'audio', audio: { mime_type: 'audio/wav' } });
    b.initialize(['choices', 0, 'items', 2, 'content', 0, 'audio', 'data'], '');
    b.append(['choices', 0, 'items', 2, 'content', 0, 'audio', 'data'], 'YQ==');
    b.event({ type: 'part_end', choice: 0, item: 2, part: 0 });
    b.event({ type: 'item_end', choice: 0, item: 2 });
    b.event({ type: 'item_end', choice: 0, item: 0 });
    b.event({ type: 'choice_end', choice: 0, finish_reason: 'tool_calls' });
    b.event({ type: 'finish', status: 'completed' });

    const result = await reassembleGeminiGenerateContentEvents(events(geminiGenerateContentFromIR(iterate(b.drain()), options)));
    expect(result.candidates?.[0].content?.parts).toEqual([
      { functionCall: { id: 'call', name: 'tool', args: {} } },
      { text: 'after tool' },
      { inlineData: { mimeType: 'audio/wav', data: 'YQ==' } },
      { thoughtSignature: 'test-sidecar' },
    ]);
  });

  it('preserves thinking and cache-write usage details', () => {
    expect(messagesUsageFromIR(messagesUsageToIR({ input_tokens: 2, output_tokens: 3, output_tokens_details: { thinking_tokens: 1 } }, {}))).toMatchObject({ output_tokens_details: { thinking_tokens: 1 } });
    expect(responsesUsageFromIR(responsesUsageToIR({ input_tokens: 2, output_tokens: 3, total_tokens: 5, input_tokens_details: { cache_write_tokens: 1 } }))).toMatchObject({ input_tokens_details: { cache_write_tokens: 1 } });
  });

  it('uses target ChatCompletions audio replay metadata across deltas', async () => {
    const frames = [chatFrame([{ index: 0, delta: { audio: { id: 'audio', expires_at: 123, data: 'YQ==' } } }]), chatFrame([{ index: 0, delta: { audio: { transcript: 'word' } } }]), chatFrame([{ index: 0, delta: {}, finish_reason: 'stop' }]), doneFrame()];
    const result = await reassembleOpenAIChatCompletionsEvents(events(openaiChatCompletionsFromIR(irFromOpenAIChatCompletions(iterate(frames)), { ...options, audioMetadata: () => ({ id: 'target-audio', expires_at: 456 }) })));
    expect(result.choices[0].message.audio).toEqual({ id: 'target-audio', expires_at: 456, data: 'YQ==', transcript: 'word' });
  });

  it('retains text-image-text order in Responses output', async () => {
    const frames = openaiResponsesFromIR(iterate(completeIR([{ type: 'message', content: [{ type: 'text', text: 'before' }, { type: 'image', image: { data: 'YQ==', mime_type: 'image/png' } }, { type: 'text', text: 'after' }] }])), options);
    const result = await reassembleOpenAIResponsesEvents(events(frames));
    expect(result.output.map(item => item.type)).toEqual(['message', 'image_generation_call', 'message', 'reasoning']);
  });

  it('marks ChatCompletions length termination incomplete and exposes IR errors', async () => {
    const frames = await collect(irFromOpenAIChatCompletions(iterate([chatFrame([{ index: 0, delta: { content: 'text' }, finish_reason: 'length' }]), doneFrame()])));
    expect(frames.find(record => record.type === 'finish')).toMatchObject({ status: 'incomplete' });
    await expect(collectIR(iterate([{ type: 'error', error: { message: 'failure' } }]))).rejects.toThrow();
  });

  it.each([true, false])('streams Responses text independently of a pending image (success=%s)', async success => {
    const image: any = { type: 'image_generation_call', id: 'img', status: 'in_progress', result: null };
    const message: any = { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'later', annotations: [null] }] };
    const resultImage = { ...image, status: success ? 'completed' : 'failed', result: success ? 'YQ==' : null };
    const response: any = { id: 's', model: 'm', output: [resultImage, message], usage: null };
    const input: any[] = [{ type: 'response.created', response: { ...response, output: [] } }, { type: 'response.output_item.added', output_index: 0, item: image }, { type: 'response.output_item.added', output_index: 1, item: message }, { type: 'response.output_item.done', output_index: 1, item: message }, { type: 'response.output_item.done', output_index: 0, item: resultImage }, { type: 'response.completed', response }];
    const frames = await collect(irFromOpenAIResponses(iterate(input.map(eventFrame))));
    const ir = await collectIR(iterate(frames));
    const parts = ir.choices[0].items.flatMap(item => item.type === 'message' ? item.content : []);
    expect(parts.map(part => part.type)).toEqual(success ? ['image', 'text'] : ['text']);
    expect(frames.filter(record => record.type === 'part_end')).toHaveLength(success ? 2 : 1);
  });

  it('closes a Responses text run with its item', async () => {
    const item: any = { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'text', annotations: [] }] };
    const response: any = { id: 's', model: 'm', status: 'completed', output: [item], usage: null };
    const input: any[] = [{ type: 'response.created', response: { ...response, output: [] } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }, { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'text' }, { type: 'response.content_part.done', output_index: 0, content_index: 0, part: item.content[0] }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
    const records = await collect(irFromOpenAIResponses(iterate(input.map(eventFrame))));
    expect(records.filter(record => record.type === 'part_end')).toEqual([{ type: 'part_end', choice: 0, item: 0, part: 0 }]);
    expect(records.findIndex(record => record.type === 'part_end')).toBeLessThan(records.findIndex(record => record.type === 'item_end'));
  });

  it.each([['Messages', anthropicMessagesFromIR, reassembleAnthropicMessagesEvents], ['GenerateContent', geminiGenerateContentFromIR, reassembleGeminiGenerateContentEvents]] as const)('allows configured JSON repair in %s', async (_name, adapter, reassemble) => {
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

  it('preserves null and omitted logprob bytes in Responses deltas and results', async () => {
    const tokens: IRJSONObject[] = [
      { token: 'a', logprob: -1, bytes: null, top_logprobs: [{ token: 'b', logprob: -2, bytes: null }] },
      { token: 'c', logprob: -3 },
    ];
    const records = completeIR([{ type: 'message', content: [{ type: 'text', text: 'ac' }] }]);
    records.splice(records.findIndex(record => record.type === 'part_end'), 0,
      { type: 'write', kind: 'initialize', path: ['choices', 0, 'logprobs'], value: [] },
      { type: 'write', kind: 'initialize', path: ['choices', 0, 'logprobs', 0], value: { scope: 'text_part', item_index: 0, content_index: 0, tokens: [] } },
      ...tokens.map((value, index) => ({ type: 'write' as const, kind: 'assign' as const, path: ['choices', 0, 'logprobs', 0, 'tokens', index], value })));
    const frames = await collect(openaiResponsesFromIR(iterate(records), options));
    const emitted = frames.flatMap(frame => frame.type === 'event' && frame.event.type === 'response.output_text.delta' ? frame.event.logprobs ?? [] : []);
    expect(emitted).toEqual(tokens);
    const result = await reassembleOpenAIResponsesEvents(events(iterate(frames)));
    expect(result.output[0]).toMatchObject({ content: [{ logprobs: tokens }] });
  });

  it.each<{ items: readonly IRItem[] }>([{ items: [] }, { items: [{ type: 'reasoning', content: ['thought'] }] }])('exposes invalid logprob item ownership %j', async ({ items }) => {
    const frames = completeIR(items);
    const end = frames.findIndex(record => record.type === 'choice_end');
    const logprobs = [
      { type: 'write', kind: 'initialize', path: ['choices', 0, 'logprobs'], value: [] },
      { type: 'write', kind: 'initialize', path: ['choices', 0, 'logprobs', 0], value: { scope: 'text_part', item_index: 0, content_index: 0, tokens: [] } },
      { type: 'write', kind: 'assign', path: ['choices', 0, 'logprobs', 0, 'tokens', 0], value: { token: 'x', logprob: -1 } },
    ] as const;
    frames.splice(end, 0, ...logprobs);
    await expect(collect(openaiChatCompletionsFromIR(iterate(frames), options))).rejects.toThrow();
  });

  it('uses the same lifecycle validation when collecting IR', async () => {
    for (const records of [[{ type: 'finish', status: 'completed' }], [{ type: 'start', id: 's', model: 'm' }, { type: 'start', id: 's', model: 'm' }, { type: 'finish', status: 'completed' }]]) {
      await expect(collectIR(iterate(records as any))).rejects.toThrow();
    }
  });

  it('preserves Responses generated image format', async () => {
    const result = await reassembleOpenAIResponsesEvents(events(openaiResponsesFromIR(iterate(completeIR([{ type: 'message', content: [{ type: 'image', image: { data: 'YQ==', mime_type: 'image/jpeg' } }] }])), options)));
    expect(result.output[0]).toMatchObject({ type: 'image_generation_call', output_format: 'jpeg' });
  });

  it.each([true, false])('preserves Responses audio when transcript arrives first=%s', async transcriptFirst => {
    const data = { type: 'response.audio.delta', delta: 'YQ==' };
    const transcript = { type: 'response.audio.transcript.delta', delta: 'hello' };
    const response = { id: 's', model: 'm', output: [] };
    const input: any[] = [{ type: 'response.created', response }, ...(transcriptFirst ? [transcript, data] : [data, transcript]), { type: 'response.audio.done' }, { type: 'response.audio.transcript.done' }, { type: 'response.completed', response }];
    const source = () => irFromOpenAIResponses(iterate(input.map(eventFrame)));
    const messages = await reassembleAnthropicMessagesEvents(events(anthropicMessagesFromIR(source(), options)));
    expect(messages.content.filter(block => block.type !== 'redacted_thinking')).toMatchObject([{ type: 'text', text: 'hello' }]);
    const chat = await reassembleOpenAIChatCompletionsEvents(events(openaiChatCompletionsFromIR(source(), { ...options, audioMetadata: () => ({ id: 'a', expires_at: 123 }) })));
    expect(chat.choices[0].message.audio).toEqual({ id: 'a', expires_at: 123, data: 'YQ==', transcript: 'hello' });
    expect(chat.choices[0].message.content).toBeNull();
    await expect(reassembleGeminiGenerateContentEvents(events(geminiGenerateContentFromIR(source(), options))))
      .rejects.toThrow('GenerateContent inline data requires a MIME type');
  });

  it('emits a transcript-only audio part once in GenerateContent', async () => {
    const result = await reassembleGeminiGenerateContentEvents(events(geminiGenerateContentFromIR(iterate(completeIR([{ type: 'message', content: [{ type: 'audio', audio: { transcript: 'hello' } }] }])), options)));
    expect(result.candidates?.[0].content?.parts).toEqual([{ text: 'hello' }, { thoughtSignature: 'test-sidecar' }]);
  });

  it('emits transcript-only audio before ChatCompletions finish_reason', async () => {
    const frames = await collect(openaiChatCompletionsFromIR(iterate(completeIR([{ type: 'message', content: [{ type: 'audio', audio: { transcript: 'hello' } }] }])), options));
    const chunks = frames.flatMap(frame => frame.type === 'event' && !('error' in frame.event) ? frame.event.choices : []);
    expect(chunks.findIndex(choice => choice.delta.content === 'hello')).toBeLessThan(chunks.findIndex(choice => choice.finish_reason === 'stop'));
  });

  it.each([['Responses', openaiResponsesFromIR], ['Messages', anthropicMessagesFromIR]] as const)('rejects completed unnamed tools in %s', async (_name, adapter) => {
    await expect(collect<unknown>(adapter(iterate(completeIR([{ type: 'function_call', name: '', arguments: '{}' }])), options))).rejects.toThrow('require a name');
  });

  it.each([
    ['ChatCompletions', openaiChatCompletionsFromIR],
    ['Responses', openaiResponsesFromIR],
    ['Messages', anthropicMessagesFromIR],
    ['GenerateContent', geminiGenerateContentFromIR],
  ] as const)('%s rejects IR start without a model', async (_name, adapter) => {
    await expect(collect<unknown>(adapter(iterate([{ type: 'start', id: 'source' }] as any), options))).rejects.toThrow('requires an IR model');
  });

});
