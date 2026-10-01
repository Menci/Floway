import { describe, expect, it, test, vi } from 'vitest';

import { decodeReasoningData, encodeReasoningData } from '../../src/common/index.ts';
import { CHAT_COMPLETIONS_REASONING_TEXT_STANDARDS, type ChatCompletionsReasoningDataStandard, type ChatCompletionsReasoningFormat, FlowayOpenAIChatCompletionsReasoning, fromFlowayOpenAIChatCompletionsReasoning, OPENROUTER_REASONING_OPAQUE_ID_PREFIX, toFlowayOpenAIChatCompletionsReasoning, reassembleOpenAIChatCompletionsEvents } from '../../src/openai-chat-completions/index.ts';

const formats: ChatCompletionsReasoningDataStandard[] = ['reasoning-opaque', 'openrouter-reasoning-details', 'litellm-thinking-blocks'];
const format = (data: ChatCompletionsReasoningDataStandard): ChatCompletionsReasoningFormat => ({ text: 'reasoning', data });
const router = [
  { type: 'reasoning.summary', summary: 'Summary.', id: 'rs_one', index: 0, format: 'openai-responses-v1', future: { retained: true } },
  { type: 'reasoning.encrypted', data: 'ciphertext', id: 'rs_one', index: 0, format: 'openai-responses-v1' },
  { type: 'reasoning.text', text: 'Signed text.', signature: 'signature', id: null, index: 1, format: 'anthropic-claude-v1' },
  { type: 'reasoning.server_tool_call', arguments: '{}', result: 'result', tool_name: 'tool', tool_call_id: 'call_one', index: 2 },
];
const blocks = [
  { type: 'thinking', thinking: 'First.', signature: 'sig-one' },
  { type: 'redacted_thinking', data: 'redacted', cache_control: { type: 'ephemeral' } },
  { type: 'thinking', thinking: 'Second.', signature: 'sig-two' },
];
const wire = (data: ChatCompletionsReasoningDataStandard) => ({
  role: 'assistant', content: 'Answer.', reasoning: 'Readable.',
  ...(data === 'reasoning-opaque' ? { reasoning_opaque: 'native-opaque' }
    : data === 'openrouter-reasoning-details' ? { reasoning_details: router }
      : { thinking_blocks: blocks }),
});

describe('Floway Chat Completions reasoning conversion', () => {
  it.each(CHAT_COMPLETIONS_REASONING_TEXT_STANDARDS.filter(text => text !== 'passthrough'))('shares the %s parser between response and history messages', text => {
    const field = text.replaceAll('-', '_');
    const warn = vi.fn();
    for (const body of [{ role: 'assistant', content: null }, { content: 'Answer.' }]) {
      const input = Object.freeze({ ...body, [field]: 'Thought.', reasoning_opaque: 'native' });
      const converted = toFlowayOpenAIChatCompletionsReasoning(input, { text, data: 'reasoning-opaque' }, { warn });
      expect(converted[FlowayOpenAIChatCompletionsReasoning]).toEqual({ reasoning: 'Thought.', reasoning_opaque: 'native' });
      expect(Object.isFrozen(converted[FlowayOpenAIChatCompletionsReasoning])).toBe(true);
      expect(Object.getOwnPropertyDescriptor(converted, FlowayOpenAIChatCompletionsReasoning)?.enumerable).toBe(true);
      expect(Object.hasOwn(converted, field)).toBe(false);
      expect(JSON.stringify(converted)).not.toContain('Thought.');
      expect(fromFlowayOpenAIChatCompletionsReasoning(converted, { text, data: 'reasoning-opaque' }, { warn })).toEqual(input);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  for (const source of formats) for (const target of formats) {
    it(`replays ${source} through ${target} without losing structure`, () => {
      const warn = vi.fn();
      const input = wire(source);
      const original = structuredClone(input);
      const internal = toFlowayOpenAIChatCompletionsReasoning(input, format(source), { warn });
      const downstream = fromFlowayOpenAIChatCompletionsReasoning(internal, format(target), { warn });
      const replay = toFlowayOpenAIChatCompletionsReasoning(downstream, format(target), { warn });
      const restored = fromFlowayOpenAIChatCompletionsReasoning(replay, format(source), { warn });
      expect(restored).toEqual(original);
      expect(input).toEqual(original);
      expect(warn).not.toHaveBeenCalled();
    });
  }

  it('uses a different owned OpenRouter ID for each generated member', () => {
    const warn = vi.fn();
    const internal = toFlowayOpenAIChatCompletionsReasoning(wire('reasoning-opaque'), format('reasoning-opaque'), { warn });
    const first = fromFlowayOpenAIChatCompletionsReasoning(internal, format('openrouter-reasoning-details'), { warn }).reasoning_details![0];
    const second = fromFlowayOpenAIChatCompletionsReasoning(internal, format('openrouter-reasoning-details'), { warn }).reasoning_details![0];
    expect(first).toMatchObject({ type: 'reasoning.encrypted', data: 'native-opaque', format: 'unknown' });
    expect(first.id).toEqual(expect.stringContaining(OPENROUTER_REASONING_OPAQUE_ID_PREFIX));
    expect(first.id).not.toBe(second.id);
    expect(first).not.toHaveProperty('index');
  });

  it('preserves a native singleton encrypted item with its metadata', () => {
    const warn = vi.fn();
    const input = { reasoning_details: [{ type: 'reasoning.encrypted', data: 'native', id: 'native-id', format: 'unknown' }] };
    const internal = toFlowayOpenAIChatCompletionsReasoning(input, format('openrouter-reasoning-details'), { warn });
    expect(decodeReasoningData(internal[FlowayOpenAIChatCompletionsReasoning]!.reasoning_opaque)?.value).toEqual(input.reasoning_details);
    expect(fromFlowayOpenAIChatCompletionsReasoning(internal, format('openrouter-reasoning-details'), { warn })).toEqual(input);
  });

  it('warns independently for alternate text and data and does not reinterpret them', () => {
    const warn = vi.fn();
    const converted = toFlowayOpenAIChatCompletionsReasoning({ content: 'Answer.', reasoning_content: 'Alternate.', thinking_blocks: [{ type: 'invalid' }] }, format('reasoning-opaque'), { warn });
    expect(converted).toEqual({ content: 'Answer.', reasoning_content: 'Alternate.', thinking_blocks: [{ type: 'invalid' }] });
    expect(warn.mock.calls.map(([warning]) => warning.channel)).toEqual(['text', 'data']);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Alternate.');
  });

  it('keeps a valid selected channel while ignoring malformed alternate data', () => {
    const warn = vi.fn();
    const converted = toFlowayOpenAIChatCompletionsReasoning({ reasoning: 'Thought.', thinking_blocks: {} }, format('reasoning-opaque'), { warn });
    expect(converted[FlowayOpenAIChatCompletionsReasoning]).toEqual({ reasoning: 'Thought.', reasoning_opaque: '' });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ channel: 'data' }));
    expect(converted).toHaveProperty('thinking_blocks', {});
  });

  it('preserves both passthrough channels without parsing or warning', () => {
    const warn = vi.fn();
    const input = Object.freeze({ reasoning_content: 'Original thought', reasoning_text: null, reasoning_opaque: 'Original secret', reasoning_details: [{ type: 'future-type', custom: true }], thinking_blocks: { future: true } });
    const converted = toFlowayOpenAIChatCompletionsReasoning(input, { text: 'passthrough', data: 'passthrough' }, { warn });
    expect(converted).toEqual(input);
    expect(converted[FlowayOpenAIChatCompletionsReasoning]).toBeUndefined();
    expect(fromFlowayOpenAIChatCompletionsReasoning(converted, { text: 'passthrough', data: 'passthrough' }, { warn })).toEqual(input);
    expect(warn).not.toHaveBeenCalled();
  });

  it('retains null, empty and unknown passthrough values in nonstream responses', async () => {
    const warn = vi.fn();
    const input = { reasoning: null, reasoning_content: '', reasoning_text: '', reasoning_opaque: null, reasoning_details: [{ type: 'future-type', custom: true }], thinking_blocks: { future: true } };
    const events = async function* () {
      const delta = toFlowayOpenAIChatCompletionsReasoning(input, { text: 'passthrough', data: 'passthrough' }, { warn });
      yield { id: 'one', object: 'chat.completion.chunk' as const, created: 1, model: 'model', choices: [{ index: 0, delta: delta as never, finish_reason: 'stop' as const }] };
    };
    expect((await reassembleOpenAIChatCompletionsEvents(events())).choices[0].message).toMatchObject(input);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps raw sibling fields while encoding internal values through passthrough', () => {
    const warn = vi.fn();
    const internal = toFlowayOpenAIChatCompletionsReasoning({ reasoning_text: 'Thought', reasoning_opaque: 'Secret', thinking_blocks: blocks }, { text: 'reasoning-text', data: 'reasoning-opaque' }, { warn });
    expect(fromFlowayOpenAIChatCompletionsReasoning(internal, { text: 'passthrough', data: 'passthrough' }, { warn })).toEqual({ reasoning: 'Thought', reasoning_opaque: 'Secret', thinking_blocks: blocks });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { text: 'passthrough', data: 'reasoning-opaque' },
    { text: 'reasoning', data: 'passthrough' },
  ] as const)('keeps raw and internal channels separate through nonstream collection ($text/$data)', async format => {
    const warn = vi.fn();
    const input = { reasoning: 'Managed thought', reasoning_text: 'Raw thought', reasoning_opaque: 'Secret' };
    const events = async function* () {
      for (const fragment of ['first ', 'second']) {
        const delta = toFlowayOpenAIChatCompletionsReasoning({ ...input, reasoning: fragment, reasoning_text: fragment }, format, { warn });
        yield { id: 'one', object: 'chat.completion.chunk' as const, created: 1, model: 'model', choices: [{ index: 0, delta, finish_reason: 'stop' as const }] };
      }
    };
    const result = await reassembleOpenAIChatCompletionsEvents(events());
    const message = result.choices[0].message;
    expect(message[FlowayOpenAIChatCompletionsReasoning]).toEqual({ reasoning: format.text === 'passthrough' ? '' : 'first second', reasoning_opaque: format.data === 'passthrough' ? '' : 'Secret' });
    const output = fromFlowayOpenAIChatCompletionsReasoning(message, { text: 'reasoning', data: 'reasoning-opaque' }, { warn });
    expect(output).toMatchObject({ reasoning: 'first second', reasoning_text: 'first second', reasoning_opaque: 'Secret' });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['reasoning-opaque', { reasoning_opaque: {} }],
    ['openrouter-reasoning-details', { reasoning_details: {} }],
    ['openrouter-reasoning-details', { reasoning_details: [{ type: 'reasoning.encrypted' }] }],
    ['openrouter-reasoning-details', { reasoning_details: [{ type: 'future-type', data: 'x' }] }],
    ['litellm-thinking-blocks', { thinking_blocks: [{ type: 'thinking', signature: 7 }] }],
    ['litellm-thinking-blocks', { thinking_blocks: [{ type: 'unknown' }] }],
  ] as const)('fails malformed selected %s data', (standard, input) => {
    const warn = vi.fn();
    expect(() => toFlowayOpenAIChatCompletionsReasoning(input, format(standard), { warn })).toThrow(TypeError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores null placeholders and reasoning-free messages quietly', () => {
    const warn = vi.fn();
    expect(toFlowayOpenAIChatCompletionsReasoning({ content: 'Text.', reasoning: null, reasoning_opaque: null }, format('reasoning-opaque'), { warn })).toEqual({ content: 'Text.' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and overwrites an existing target field while preserving the internal snapshot', () => {
    const warn = vi.fn();
    const internal = toFlowayOpenAIChatCompletionsReasoning(wire('reasoning-opaque'), format('reasoning-opaque'), { warn });
    const snapshot = Object.freeze({ ...internal, reasoning: 'Stale.', reasoning_opaque: 'Stale.' });
    const output = fromFlowayOpenAIChatCompletionsReasoning(snapshot, format('reasoning-opaque'), { warn });
    expect(output).toMatchObject({ reasoning: 'Readable.', reasoning_opaque: 'native-opaque' });
    expect(Object.getOwnPropertySymbols(output)).not.toContain(FlowayOpenAIChatCompletionsReasoning);
    expect(snapshot[FlowayOpenAIChatCompletionsReasoning]).toBe(internal[FlowayOpenAIChatCompletionsReasoning]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('accumulates OpenRouter summaries and late signatures while keeping encrypted items distinct', () => {
    const warn = vi.fn();
    let previousOpaque = '';
    for (const reasoning_details of [
      [{ type: 'reasoning.summary', summary: 'First ', index: 0 }],
      [{ type: 'reasoning.summary', summary: 'summary.', index: 0 }],
      [{ type: 'reasoning.encrypted', data: 'cipher-one', id: 'rs_one', index: 0 }],
      [{ type: 'reasoning.text', text: 'Signed.', index: 1 }],
      [{ type: 'reasoning.text', signature: 'signature', index: 1 }],
      [{ type: 'reasoning.encrypted', data: 'cipher-two', id: 'rs_two', index: 0 }],
    ]) {
      const message = toFlowayOpenAIChatCompletionsReasoning({ reasoning_details }, format('openrouter-reasoning-details'), { warn, stream: { previousOpaque } });
      previousOpaque = message[FlowayOpenAIChatCompletionsReasoning]!.reasoning_opaque;
    }
    expect(decodeReasoningData(previousOpaque)?.value).toEqual([
      { type: 'reasoning.summary', summary: 'First summary.', index: 0 },
      { type: 'reasoning.encrypted', data: 'cipher-one', id: 'rs_one', index: 0 },
      { type: 'reasoning.text', text: 'Signed.', signature: 'signature', index: 1 },
      { type: 'reasoning.encrypted', data: 'cipher-two', id: 'rs_two', index: 0 },
    ]);
  });

  it('recognizes the LiteLLM signed snapshot instead of duplicating thinking text', () => {
    const warn = vi.fn();
    let previousOpaque = '';
    for (const thinking_blocks of [
      [{ type: 'thinking', thinking: 'First ' }],
      [{ type: 'thinking', thinking: 'thought.' }],
      [{ type: 'thinking', thinking: 'First thought.', signature: 'sig-one' }],
      [{ type: 'redacted_thinking', data: 'hidden' }],
      [{ type: 'thinking', thinking: 'Second.', signature: 'sig-two' }],
    ]) {
      const message = toFlowayOpenAIChatCompletionsReasoning({ thinking_blocks }, format('litellm-thinking-blocks'), { warn, stream: { previousOpaque } });
      previousOpaque = message[FlowayOpenAIChatCompletionsReasoning]!.reasoning_opaque;
    }
    expect(decodeReasoningData(previousOpaque)?.value).toEqual([
      { type: 'thinking', thinking: 'First thought.', signature: 'sig-one' },
      { type: 'redacted_thinking', data: 'hidden' },
      { type: 'thinking', thinking: 'Second.', signature: 'sig-two' },
    ]);
  });

  it('rejects damaged owned envelopes with the original error chain', () => {
    const warn = vi.fn();
    expect(() => toFlowayOpenAIChatCompletionsReasoning({ reasoning_opaque: 'floway-reasoning-v1:invalid' }, format('reasoning-opaque'), { warn })).toThrow('Malformed Floway reasoning data envelope');
    const invalid = encodeReasoningData('openrouter-reasoning-details', [{ type: 'reasoning.encrypted', data: 7 }]);
    const message = { [FlowayOpenAIChatCompletionsReasoning]: Object.freeze({ reasoning: '', reasoning_opaque: invalid }) };
    expect(() => fromFlowayOpenAIChatCompletionsReasoning(message, format('openrouter-reasoning-details'), { warn })).toThrow(TypeError);
  });
});

const warn = vi.fn();

test.each(['openrouter-reasoning-details', 'litellm-thinking-blocks'] as const)('preserves an explicit empty %s array', data => {
  const field = data === 'openrouter-reasoning-details' ? 'reasoning_details' : 'thinking_blocks';
  const wire = { role: 'assistant', [field]: [] };
  const format = { text: 'reasoning' as const, data };
  expect(fromFlowayOpenAIChatCompletionsReasoning(toFlowayOpenAIChatCompletionsReasoning(wire, format, { warn }), format, { warn })).toEqual(wire);
});

test('recognizes generated OpenRouter opaque bridges in stream deltas', () => {
  const format = { text: 'reasoning' as const, data: 'openrouter-reasoning-details' as const };
  const wire = fromFlowayOpenAIChatCompletionsReasoning({ [FlowayOpenAIChatCompletionsReasoning]: { reasoning: '', reasoning_opaque: 'native' } }, format, { warn });
  const normalized = toFlowayOpenAIChatCompletionsReasoning(wire, format, { warn, stream: { previousOpaque: '' } });
  expect(normalized[FlowayOpenAIChatCompletionsReasoning]?.reasoning_opaque).toBe('native');
});

test('keeps incoming member boundaries and signature-only thinking text', () => {
  const format = { text: 'reasoning' as const, data: 'litellm-thinking-blocks' as const };
  const first = toFlowayOpenAIChatCompletionsReasoning({ thinking_blocks: [{ type: 'thinking', thinking: 'First', future: 1 }, { type: 'thinking', thinking: 'Second', future: 2 }] }, format, { warn, stream: { previousOpaque: '' } });
  const second = toFlowayOpenAIChatCompletionsReasoning({ thinking_blocks: [{ type: 'thinking', thinking: '', signature: 'signature', future: 2 }] }, format, { warn, stream: { previousOpaque: first[FlowayOpenAIChatCompletionsReasoning]!.reasoning_opaque } });
  expect(fromFlowayOpenAIChatCompletionsReasoning(second, format, { warn }).thinking_blocks).toEqual([{ type: 'thinking', thinking: 'First', future: 1 }, { type: 'thinking', thinking: 'Second', signature: 'signature', future: 2 }]);
});
