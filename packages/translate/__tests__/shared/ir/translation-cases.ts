import { expect, test } from 'vitest';

import { collect, iterate } from './helpers.ts';
import { collectAnthropicMessagesProtocolEventsToResult } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, doneFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult } from '@floway-dev/protocols/gemini-generate-content';
import { collectOpenAIChatCompletionsProtocolEventsToResult } from '@floway-dev/protocols/openai-chat-completions';
import { collectOpenAIResponsesProtocolEventsToResult, openaiResponsesResultToEvents } from '@floway-dev/protocols/openai-responses';

type Wire = Record<string, any>;
export type IRTestProtocol = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages' | 'gemini-generate-content';
interface Fixture { text?: string[]; refusal?: string; thinking?: string[]; signature?: string; tools?: { name: string; id: string; args: Wire }[]; stop?: string; usage?: Wire; tier?: string }

export const fixtureFrames = (protocol: IRTestProtocol, fixture: Fixture): ProtocolFrame<any>[] => {
  const text = fixture.text ?? [];
  const thinking = fixture.thinking ?? [];
  const tools = fixture.tools ?? [];
  const stop = fixture.stop ?? (tools.length > 0 ? 'tool_calls' : 'stop');
  const usage = fixture.usage;
  if (protocol === 'openai-chat-completions') {
    const chunk = (delta: Wire, finish_reason: string | null = null, extra: Wire = {}) => eventFrame({ id: 'chatcmpl_test', object: 'chat.completion.chunk', model: 'served-model', created: 100, choices: [{ index: 0, delta, finish_reason }], ...(fixture.tier === undefined ? {} : { service_tier: fixture.tier }), ...extra });
    return [chunk({ role: 'assistant' }), ...thinking.map(reasoning_text => chunk({ reasoning_text })), ...(fixture.signature === undefined ? [] : [chunk({ reasoning_opaque: fixture.signature })]), ...text.map(content => chunk({ content })), ...(fixture.refusal === undefined ? [] : [chunk({ refusal: fixture.refusal })]), ...tools.flatMap((tool, index) => {
      const args = JSON.stringify(tool.args);
      return [chunk({ tool_calls: [{ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: args.slice(0, 2) } }] }), chunk({ tool_calls: [{ index, function: { arguments: args.slice(2) } }] })];
    }), chunk({}, stop), ...(usage === undefined ? [] : [eventFrame({ id: 'chatcmpl_test', model: 'served-model', created: 100, choices: [], usage })]), doneFrame()];
  }
  if (protocol === 'openai-responses') {
    const output: any[] = [
      ...(thinking.length === 0 && fixture.signature === undefined ? [] : [{ type: 'reasoning', id: 'rs_source', summary: thinking.map(text => ({ type: 'summary_text', text })), ...(fixture.signature === undefined ? {} : { encrypted_content: fixture.signature }) }]),
      ...(text.length === 0 && fixture.refusal === undefined ? [] : [{ type: 'message', id: 'msg_source', role: 'assistant', status: 'completed', content: [...text.map(text => ({ type: 'output_text', text, annotations: [] })), ...(fixture.refusal === undefined ? [] : [{ type: 'refusal', refusal: fixture.refusal }])] }]),
      ...tools.map((tool, index) => ({ type: 'function_call', id: `fc_${index}`, call_id: tool.id, name: tool.name, arguments: JSON.stringify(tool.args), status: 'completed' })),
    ];
    return openaiResponsesResultToEvents({ id: 'resp_test', object: 'response', created_at: 100, model: 'served-model', output, status: stop === 'length' || stop === 'content_filter' ? 'incomplete' : 'completed', error: null, incomplete_details: stop === 'length' ? { reason: 'max_output_tokens' } : stop === 'content_filter' ? { reason: 'content_filter' } : null, ...(usage === undefined ? {} : { usage }), ...(fixture.tier === undefined ? {} : { service_tier: fixture.tier }) } as any);
  }
  const blocks: Wire[] = [
    ...thinking.map(thinking => ({ type: 'thinking', thinking, signature: fixture.signature ?? '' })),
    ...(thinking.length === 0 && fixture.signature !== undefined ? [{ type: 'redacted_thinking', data: fixture.signature }] : []),
    ...text.map(text => ({ type: 'text', text })),
    ...(fixture.refusal === undefined ? [] : [{ type: 'text', text: fixture.refusal }]),
    ...tools.map(tool => ({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.args })),
  ];
  const frames: ProtocolFrame<any>[] = [eventFrame({ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'served-model', content: [], usage: { input_tokens: 0, output_tokens: 0, ...usage }, ...(fixture.tier === undefined ? {} : { usage: { input_tokens: 0, output_tokens: 0, ...usage, service_tier: fixture.tier } }) } })];
  blocks.forEach((block, index) => {
    const field = block.type === 'text' ? 'text' : block.type === 'thinking' ? 'thinking' : undefined;
    frames.push(eventFrame({ type: 'content_block_start', index, content_block: field === undefined ? block.type === 'tool_use' ? { ...block, input: {} } : block : { ...block, [field]: '', ...(block.type === 'thinking' ? { signature: '' } : {}) } }));
    if (field !== undefined) {
      const value = block[field] as string;
      for (const delta of [value.slice(0, 1), value.slice(1)]) frames.push(eventFrame({ type: 'content_block_delta', index, delta: { type: `${field}_delta`, [field]: delta } }));
      if (block.type === 'thinking') frames.push(eventFrame({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }));
    }
    if (block.type === 'tool_use') frames.push(eventFrame({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }));
    frames.push(eventFrame({ type: 'content_block_stop', index }));
  });
  frames.push(eventFrame({ type: 'message_delta', delta: { stop_reason: stop === 'length' ? 'max_tokens' : stop === 'tool_calls' ? 'tool_use' : stop === 'content_filter' ? 'refusal' : 'end_turn', stop_details: stop === 'content_filter' ? { type: 'refusal', category: null, explanation: null } : null }, usage: { output_tokens: usage?.output_tokens ?? 0 } }), eventFrame({ type: 'message_stop' }));
  return frames;
};

export const nativeResult = async (protocol: IRTestProtocol, frames: ProtocolFrame<any>[]): Promise<Wire> => {
  const source = iterate(frames);
  switch (protocol) {
  case 'openai-chat-completions': return await collectOpenAIChatCompletionsProtocolEventsToResult(source);
  case 'openai-responses': return await collectOpenAIResponsesProtocolEventsToResult(source);
  case 'anthropic-messages': return await collectAnthropicMessagesProtocolEventsToResult(source);
  case 'gemini-generate-content': return await collectGeminiGenerateContentProtocolEventsToResult(source);
  }
};

const bodyText = (protocol: IRTestProtocol, result: Wire): string => {
  if (protocol === 'openai-chat-completions') return (result.choices[0]?.message.content ?? '') + (result.choices[0]?.message.refusal ?? '');
  if (protocol === 'openai-responses') return result.output.flatMap((i: Wire) => i.type === 'message' ? i.content.map((p: Wire) => p.text ?? p.refusal) : []).join('');
  if (protocol === 'anthropic-messages') return result.content.filter((p: Wire) => p.type === 'text').map((p: Wire) => p.text).join('');
  return result.candidates[0]?.content?.parts.filter((p: Wire) => !p.thought).map((p: Wire) => p.text ?? '').join('') ?? '';
};
const reasoningText = (protocol: IRTestProtocol, result: Wire): string => {
  if (protocol === 'openai-chat-completions') return result.choices[0].message.reasoning_text ?? '';
  if (protocol === 'openai-responses') return result.output.filter((i: Wire) => i.type === 'reasoning').flatMap((i: Wire) => [...i.summary ?? [], ...i.content ?? []].map((p: Wire) => p.text)).join('');
  if (protocol === 'anthropic-messages') return result.content.filter((p: Wire) => p.type === 'thinking').map((p: Wire) => p.thinking).join('');
  return result.candidates[0]?.content?.parts.filter((p: Wire) => p.thought).map((p: Wire) => p.text).join('') ?? '';
};
const toolCalls = (protocol: IRTestProtocol, result: Wire): Wire[] => {
  if (protocol === 'openai-chat-completions') return (result.choices[0].message.tool_calls ?? []).map((call: Wire) => ({ name: call.function.name, id: call.id, args: JSON.parse(call.function.arguments) }));
  if (protocol === 'openai-responses') return result.output.filter((i: Wire) => i.type === 'function_call').map((i: Wire) => ({ name: i.name, id: i.call_id, args: JSON.parse(i.arguments) }));
  if (protocol === 'anthropic-messages') return result.content.filter((p: Wire) => p.type === 'tool_use').map((p: Wire) => ({ name: p.name, id: p.id, args: p.input }));
  return result.candidates[0]?.content?.parts.flatMap((p: Wire) => p.functionCall === undefined ? [] : [p.functionCall]) ?? [];
};

export const testOutputTranslation = (target: IRTestProtocol, source: IRTestProtocol, translate: (frames: AsyncIterable<ProtocolFrame<any>>) => AsyncIterable<ProtocolFrame<any>>): void => {
  const run = async (fixture: Fixture) => await nativeResult(target, await collect(translate(iterate(fixtureFrames(source, fixture)))));
  test.each(['hello', '', 'A😀中B', '\ud800', 'line\nnext', '"quoted"', '\u0000'])('preserves generated text %j through the native return stream', async text => {
    expect(bodyText(target, await run({ text: [text] }))).toBe(text);
  });
  test('preserves multipart text order', async () => { expect(bodyText(target, await run({ text: ['one', 'two', 'three'] }))).toBe('onetwothree'); });
  test.each(['Cannot help.', ''])('preserves model-generated refusal prose %j', async refusal => {
    const result = await run({ refusal });
    expect(bodyText(target, result)).toBe(refusal);
    if (target === 'anthropic-messages') { expect(result.stop_reason).toBe('end_turn'); expect(result.stop_details).toBeNull(); }
  });
  test('concatenates all readable reasoning groups without duplicating body text', async () => {
    const result = await run({ thinking: ['first', 'second'], text: ['answer'] });
    expect(reasoningText(target, result)).toBe('firstsecond'); expect(bodyText(target, result)).toBe('answer');
  });
  test('retains opaque reasoning independently of visible text', async () => {
    const result = await run({ thinking: ['reason'], signature: 'opaque', text: ['answer'] });
    expect(reasoningText(target, result)).toBe('reason'); expect(bodyText(target, result)).toBe('answer');
    if (target === 'gemini-generate-content') expect(result.candidates[0].content.parts).toContainEqual({ thoughtSignature: 'opaque' });
    if (target === 'anthropic-messages') expect(result.content.find((p: Wire) => p.type === 'thinking').signature).toBe(source === 'openai-responses' ? 'opaque@rs_source' : 'opaque');
  });
  test('retains opaque-only reasoning without manufacturing prose', async () => {
    const result = await run({ signature: 'opaque', text: ['answer'] });
    expect(reasoningText(target, result)).toBe(''); expect(bodyText(target, result)).toBe('answer');
  });
  test.each<Wire>([{}, { query: 'hello', nested: { list: [1, true, null] } }, JSON.parse('{"__proto__":"value","constructor":"text"}')])('preserves function call JSON and identity %j', async args => {
    const tool = { id: 'call_test', name: 'lookup', args };
    expect(toolCalls(target, await run({ tools: [tool] }))).toEqual([tool]);
  });
  test('preserves several tools and text before the tools', async () => {
    const tools = [{ id: 'call_a', name: 'first', args: { a: 1 } }, { id: 'call_b', name: 'second', args: { b: 2 } }];
    const result = await run({ text: ['before'], tools });
    expect(bodyText(target, result)).toBe('before'); expect(toolCalls(target, result)).toEqual(tools);
  });
  test.each(['stop', 'length', 'content_filter'])('preserves %s termination', async stop => {
    const result = await run({ text: ['partial'], stop });
    const finish = target === 'openai-chat-completions' ? result.choices[0].finish_reason : target === 'openai-responses' ? result.status : target === 'anthropic-messages' ? result.stop_reason : result.candidates[0].finishReason;
    const expected = target === 'openai-chat-completions' ? stop : target === 'openai-responses' ? stop === 'stop' ? 'completed' : 'incomplete' : target === 'anthropic-messages' ? stop === 'stop' ? 'end_turn' : stop === 'length' ? 'max_tokens' : 'refusal' : stop === 'stop' ? 'STOP' : stop === 'length' ? 'MAX_TOKENS' : 'SAFETY';
    expect(finish).toBe(expected);
  });
  test('preserves measured usage, cache counts, and reasoning counts', async () => {
    const usage = source === 'openai-chat-completions' ? { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } } : source === 'openai-responses' ? { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } : { input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens_details: { thinking_tokens: 1 } };
    const result = await run({ text: ['answer'], usage });
    if (target === 'openai-chat-completions') expect(result.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 3, cache_creation_input_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } });
    if (target === 'openai-responses') expect(result.usage).toMatchObject({ input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } });
    if (target === 'anthropic-messages') expect(result.usage).toMatchObject({ input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens_details: { thinking_tokens: 1 } });
    if (target === 'gemini-generate-content') expect(result.usageMetadata).toMatchObject({ promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 14, cachedContentTokenCount: 3, thoughtsTokenCount: 1 });
  });
  test('stops pulling the upstream after its native terminal', async () => {
    let pulled = false;
    const upstream = async function* () { yield* fixtureFrames(source, { text: ['answer'] }); pulled = true; throw new Error('Trailing frame was pulled'); };
    await collect(translate(upstream())); expect(pulled).toBe(false);
  });
  test('rejects a truncated upstream lifecycle', async () => {
    const input = fixtureFrames(source, { text: ['partial'] });
    const truncated = source === 'openai-chat-completions' ? input.slice(0, -2) : source === 'openai-responses' ? input.filter(frame => frame.type === 'event' && !['response.completed', 'response.incomplete'].includes(frame.event.type)) : input.slice(0, -1);
    await expect(collect(translate(iterate(truncated)))).rejects.toThrow();
  });
  test('preserves successful final output through the native collector', async () => { expect(bodyText(target, await run({ text: ['answer'] }))).toBe('answer'); });
};
