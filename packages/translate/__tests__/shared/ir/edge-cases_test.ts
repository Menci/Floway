import { expect, test, vi } from 'vitest';

import { collect, iterate } from './helpers.ts';
import { fixtureFrames, nativeResult } from './translation-cases.ts';
import { translateToSourceEvents as messagesViaChat } from '../../../src/anthropic-messages-via-openai-chat-completions/events.ts';
import { translateToSourceEvents as messagesViaResponses } from '../../../src/anthropic-messages-via-openai-responses/events.ts';
import { translateToSourceEvents as generateContentViaChat } from '../../../src/gemini-generate-content-via-openai-chat-completions/events.ts';
import { translateToSourceEvents as generateContentViaResponses } from '../../../src/gemini-generate-content-via-openai-responses/events.ts';
import { translateToSourceEvents as responsesViaMessages } from '../../../src/openai-responses-via-anthropic-messages/events.ts';
import { translateToSourceEvents as responsesViaChat } from '../../../src/openai-responses-via-openai-chat-completions/events.ts';
import { irFromOpenAIChatCompletions } from '../../../src/shared/ir/sse-from/openai-chat-completions/index.ts';
import { collectIR } from '../../../src/shared/ir/stream.ts';
import { eventFrame } from '@floway-dev/protocols/common';

for (const [code, category] of [['bio_policy', 'bio'], ['cyber_policy', 'cyber']] as const) {
  test(`${code} becomes a structured Messages classifier refusal without invented body text`, async () => {
    const source = [eventFrame({ type: 'response.failed', response: { id: 'resp_policy', model: 'served', output: [], status: 'failed', error: { code, message: 'Classifier declined.' } } })];
    const frames = await collect(messagesViaResponses(iterate(source as any)));
    const result = await nativeResult('anthropic-messages', frames);
    expect(result.content).toEqual([]);
    expect(result.stop_reason).toBe('refusal');
    expect(result.stop_details).toEqual({ type: 'refusal', category, explanation: 'Classifier declined.' });
  });
  test(`${code} becomes a GenerateContent safety termination`, async () => {
    const frames = await collect(generateContentViaResponses(iterate([eventFrame({ type: 'response.failed', response: { id: 'resp_policy', model: 'served', output: [], status: 'failed', error: { code, message: 'Classifier declined.' } } })] as any)));
    expect(frames.at(-1)).toMatchObject({ event: { candidates: [{ finishReason: 'SAFETY', finishMessage: 'Classifier declined.' }] } });
  });
}

test.each(['The model failed.', 'The safety policy service is unavailable.'])('a server error stays an error regardless of message keywords: %s', async message => {
  const frames = await collect(generateContentViaResponses(iterate([eventFrame({ type: 'response.failed', response: { id: 'resp_failed', model: 'served', output: [], status: 'failed', error: { code: 'server_error', message } } })] as any)));
  expect(frames).toEqual([eventFrame({ error: { code: 500, status: 'INTERNAL', message } })]);
});

test('rate limiting becomes a native GenerateContent error', async () => {
  const frames = await collect(generateContentViaResponses(iterate([eventFrame({ type: 'error', code: 'rate_limit_exceeded', message: 'Try later.' })] as any)));
  expect(frames).toEqual([eventFrame({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Try later.' } })]);
});

test('an upstream context failure retains the Messages client compaction signal', async () => {
  const frames = await collect(messagesViaResponses(iterate([eventFrame({ type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: 'Context exceeded.' } } })] as any)));
  expect(frames).toMatchObject([{ event: { type: 'error', error: { type: 'invalid_request_error', message: expect.stringContaining('prompt is too long') } } }]);
});

for (const source of ['openai-chat-completions', 'anthropic-messages'] as const) {
  for (const wrapped of [{ input: 'print(1)' }, { other: 1 }]) {
    test(`Responses via ${source} restores wrapped custom input ${JSON.stringify(wrapped)}`, async () => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const frames = fixtureFrames(source, { tools: [{ name: 'run_code', id: 'call_custom', args: wrapped }] });
        const output = source === 'openai-chat-completions' ? responsesViaChat(iterate(frames), new Set(['run_code'])) : responsesViaMessages(iterate(frames), 'resp_custom', 'requested', new Set(['run_code']));
        const result = await nativeResult('openai-responses', await collect(output));
        expect(result.output).toEqual([expect.objectContaining({ type: 'custom_tool_call', call_id: 'call_custom', name: 'run_code', input: 'input' in wrapped ? wrapped.input : JSON.stringify(wrapped) })]);
        expect(warning).toHaveBeenCalledTimes('input' in wrapped ? 0 : 1);
      } finally { warning.mockRestore(); }
    });
  }
}

test('ChatCompletions EOF succeeds after explicit choice completion and fails before it', async () => {
  const frames = fixtureFrames('openai-chat-completions', { text: ['answer'] });
  expect((await collectIR(irFromOpenAIChatCompletions(iterate(frames.slice(0, -1))))).choices[0].items).toMatchObject([{ content: [{ text: 'answer' }] }]);
  await expect(collectIR(irFromOpenAIChatCompletions(iterate(frames.slice(0, -2))))).rejects.toThrow('finish_reason');
});

test.each([messagesViaChat, generateContentViaChat])('completed empty function JSON is rejected by object-requiring destinations', async translate => {
  const frames = fixtureFrames('openai-chat-completions', { tools: [{ name: 'lookup', id: 'call_empty', args: {} }] });
  for (const frame of frames) if (frame.type === 'event') for (const choice of frame.event.choices) for (const call of choice.delta.tool_calls ?? []) if (call.function.arguments !== undefined) call.function.arguments = '';
  await expect(collect<any>(translate(iterate(frames)))).rejects.toThrow();
});

test('a late readable reasoning carrier does not duplicate the scalar text', async () => {
  const frames = fixtureFrames('openai-chat-completions', { thinking: ['firstsecond'], text: ['answer'] });
  frames.splice(-2, 0, eventFrame({ id: 'chatcmpl_test', model: 'served-model', created: 100, choices: [{ index: 0, delta: { reasoning_items: [{ type: 'reasoning', id: 'rs_original', summary: [{ type: 'summary_text', text: 'first' }, { type: 'summary_text', text: 'second' }] }] }, finish_reason: null }] }));
  const result = await nativeResult('anthropic-messages', await collect(messagesViaChat(iterate(frames))));
  expect(result.content.filter((part: any) => part.type === 'thinking').map((part: any) => part.thinking).join('')).toBe('firstsecond');
});
