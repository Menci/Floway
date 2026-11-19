import { describe, expect, it } from 'vitest';

import { writeAnthropicMessagesEvents, writeGeminiGenerateContentEvents, readAnthropicMessagesEvents, readOpenAIChatCompletionsEvents, readOpenAIResponsesEvents, writeOpenAIChatCompletionsEvents, writeOpenAIResponsesEvents } from './helpers.ts';
import { createIRBuilder } from '../../src/ir/output/builder.ts';
import { collectIR, completeIR } from '../ir/output/helpers.ts';
import { collect, events, iterate } from '../shared/iterables.ts';
import { reassembleAnthropicMessagesEvents, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { reassembleGeminiGenerateContentEvents } from '@floway-dev/protocols/gemini-generate-content';
import { reassembleOpenAIChatCompletionsEvents, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { openaiResponsesResultToEvents, reassembleOpenAIResponsesEvents, type OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

const options = { id: 'target', created: 1 };
const chatFrame = (choices: any[], usage?: any) => eventFrame({ id: 'source', object: 'chat.completion.chunk', model: 'model', created: 1, choices, ...(usage === undefined ? {} : { usage }) } as OpenAIChatCompletionsStreamEvent);
const chat = () => readOpenAIChatCompletionsEvents(iterate([
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
const responses = () => readOpenAIResponsesEvents(responseFrames());
const messages = () => readAnthropicMessagesEvents(iterate([
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
  const irFrames = await collect(readOpenAIChatCompletionsEvents(iterate(nativeFrames as any[])));
  const chatFrames = await collect(writeOpenAIChatCompletionsEvents(iterate(irFrames)));
  const responsesFrames = await collect(writeOpenAIResponsesEvents(iterate(irFrames)));
  const messagesFrames = await collect(writeAnthropicMessagesEvents(iterate(irFrames)));
  const generateContentFrames = await collect(writeGeminiGenerateContentEvents(iterate(irFrames)));
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

describe('output IR streaming', () => {
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

  it('Responses output keeps split source text parts and completes item lifecycles', async () => {
    const frames = await collect(writeOpenAIResponsesEvents(responses(), options));
    const result = await reassembleOpenAIResponsesEvents(events(iterate(frames)));
    const message = result.output.find(item => item.type === 'message');
    expect(message?.type === 'message' && message.content).toEqual([
      { type: 'output_text', text: 'A😀', annotations: [], logprobs: [] },
      { type: 'output_text', text: '中B', annotations: [], logprobs: [] },
    ]);
    expect(result.output.find(item => item.type === 'function_call')).toMatchObject({ name: 'tool', arguments: '{"a":1}' });
    const sequence = frames.flatMap(frame => frame.type === 'event' ? [frame.event.sequence_number!] : []);
    expect(sequence).toEqual(sequence.map((_, index) => index));
    expect(frames.at(-1)?.type).toBe('event');
  });

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

  it('delivers text before pulling the upstream completion', async () => {
    let exhausted = false;
    const upstream = async function* () {
      yield chatFrame([{ index: 0, delta: { content: 'first' } }]);
      exhausted = true;
      yield chatFrame([{ index: 0, delta: {}, finish_reason: 'stop' }]); yield doneFrame();
    };
    const stream = writeOpenAIChatCompletionsEvents(readOpenAIChatCompletionsEvents(upstream()), options);
    let found = false;
    for await (const frame of stream) if (frame.type === 'event' && !('error' in frame.event) && frame.event.choices[0]?.delta.content === 'first') {
      expect(exhausted).toBe(false); found = true; break;
    }
    expect(found).toBe(true);
  });

  it('emits each candidate end before pulling the next choice or late final usage', async () => {
    const b = createIRBuilder();
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
    const output = events(writeGeminiGenerateContentEvents(source(), options));
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
    b.initialize(['choices', 0, 'items', 2, 'content', 0], { type: 'audio', audio: { media_type: 'audio/wav' } });
    b.initialize(['choices', 0, 'items', 2, 'content', 0, 'audio', 'data'], '');
    b.append(['choices', 0, 'items', 2, 'content', 0, 'audio', 'data'], 'YQ==');
    b.event({ type: 'part_end', choice: 0, item: 2, part: 0 });
    b.event({ type: 'item_end', choice: 0, item: 2 });
    b.event({ type: 'item_end', choice: 0, item: 0 });
    b.event({ type: 'choice_end', choice: 0, finish_reason: 'tool_calls' });
    b.event({ type: 'finish', status: 'completed' });

    const result = await reassembleGeminiGenerateContentEvents(events(writeGeminiGenerateContentEvents(iterate(b.drain()), options)));
    expect(result.candidates?.[0].content?.parts).toEqual([
      { functionCall: { id: 'call', name: 'tool', args: {} } },
      { text: 'after tool' },
      { inlineData: { mimeType: 'audio/wav', data: 'YQ==' } },
      { thoughtSignature: 'test-sidecar' },
    ]);
  });

  it.each([true, false])('streams Responses text independently of a pending image (success=%s)', async success => {
    const image: any = { type: 'image_generation_call', id: 'img', status: 'in_progress', result: null };
    const message: any = { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'later', annotations: [null] }] };
    const resultImage = { ...image, status: success ? 'completed' : 'failed', result: success ? 'YQ==' : null };
    const response: any = { id: 's', model: 'm', output: [resultImage, message], usage: null };
    const input: any[] = [{ type: 'response.created', response: { ...response, output: [] } }, { type: 'response.output_item.added', output_index: 0, item: image }, { type: 'response.output_item.added', output_index: 1, item: message }, { type: 'response.output_item.done', output_index: 1, item: message }, { type: 'response.output_item.done', output_index: 0, item: resultImage }, { type: 'response.completed', response }];
    const frames = await collect(readOpenAIResponsesEvents(iterate(input.map(eventFrame))));
    const ir = await collectIR(iterate(frames));
    const parts = ir.choices[0].items.flatMap(item => item.type === 'message' ? item.content : []);
    expect(parts.map(part => part.type)).toEqual(success ? ['image', 'text'] : ['text']);
    expect(frames.filter(record => record.type === 'part_end')).toHaveLength(success ? 2 : 1);
  });

  it.each([['Messages', writeAnthropicMessagesEvents, reassembleAnthropicMessagesEvents], ['GenerateContent', writeGeminiGenerateContentEvents, reassembleGeminiGenerateContentEvents]] as const)('allows configured JSON repair in %s', async (_name, adapter, reassemble) => {
    const frames = completeIR([{ type: 'function_call', name: 'tool', call_id: 'c', arguments: '{"a":1' }]);
    const output = adapter(iterate(frames), { ...options, parseToolArguments: text => JSON.parse(`${text}}`) });
    const result: any = await (reassemble as any)(events<unknown>(output));
    expect(_name === 'Messages' ? result.content.find((block: any) => block.type === 'tool_use').input : result.candidates[0].content.parts.find((part: any) => part.functionCall).functionCall.args).toEqual({ a: 1 });
    await expect((reassemble as any)(events<unknown>(adapter(iterate(frames), options)))).rejects.toThrow();
  });

  it('waits for function names before Responses item creation', async () => {
    const frames = await collect(writeOpenAIResponsesEvents(chat(), options));
    const added = frames.flatMap(frame => frame.type === 'event' && frame.event.type === 'response.output_item.added' && frame.event.item.type === 'function_call' ? [frame.event.item] : []);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ name: 'tool', call_id: 'call' });
  });

  it.each([true])('preserves Responses audio when transcript arrives first=%s', async transcriptFirst => {
    const data = { type: 'response.audio.delta', delta: 'YQ==' };
    const transcript = { type: 'response.audio.transcript.delta', delta: 'hello' };
    const response = { id: 's', model: 'm', output: [] };
    const input: any[] = [{ type: 'response.created', response }, ...(transcriptFirst ? [transcript, data] : [data, transcript]), { type: 'response.audio.done' }, { type: 'response.audio.transcript.done' }, { type: 'response.completed', response }];
    const source = () => readOpenAIResponsesEvents(iterate(input.map(eventFrame)));
    const messages = await reassembleAnthropicMessagesEvents(events(writeAnthropicMessagesEvents(source(), options)));
    expect(messages.content.filter(block => block.type !== 'redacted_thinking')).toMatchObject([{ type: 'text', text: 'hello' }]);
    const chat = await reassembleOpenAIChatCompletionsEvents(events(writeOpenAIChatCompletionsEvents(source(), { ...options, audioMetadata: () => ({ id: 'a', expires_at: 123 }) })));
    expect(chat.choices[0].message.audio).toEqual({ id: 'a', expires_at: 123, data: 'YQ==', transcript: 'hello' });
    expect(chat.choices[0].message.content).toBeNull();
    await expect(reassembleGeminiGenerateContentEvents(events(writeGeminiGenerateContentEvents(source(), options)))).rejects.toThrow();
  });

});
