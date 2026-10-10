import { expect, test } from 'vitest';

import { translateToSourceEvents as messagesViaResponses } from '../../../src/anthropic-messages-via-openai-responses/events.ts';
import { translateToSourceEvents as chatViaResponses } from '../../../src/openai-chat-completions-via-openai-responses/events.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

test.each([
  ['ChatCompletions', chatViaResponses],
  ['Messages', messagesViaResponses],
] as const)('%s returns its initial envelope before pulling beyond Responses creation', async (protocol, convert) => {
  const response = { id: 'resp_initial', object: 'response', model: 'served', created_at: 7, status: 'in_progress', output: [], usage: null, service_tier: 'fast', error: null, incomplete_details: null };
  let reached!: () => void;
  let release!: () => void;
  const atGate = new Promise<'pull'>(resolve => { reached = () => resolve('pull'); });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const source = async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
    yield eventFrame({ type: 'response.created', response } as OpenAIResponsesStreamEventEx);
    reached();
    await gate;
    yield eventFrame({ type: 'response.in_progress', response } as OpenAIResponsesStreamEventEx);
    yield eventFrame({ type: 'response.completed', response: { ...response, status: 'completed' } } as OpenAIResponsesStreamEventEx);
  };
  const stream = convert(source())[Symbol.asyncIterator]();
  const pending = stream.next();
  const first = await Promise.race([pending.then(() => 'frame' as const), atGate]);
  release();
  const initial = await pending;
  const frames: ProtocolFrame<any>[] = [];
  if (!initial.done) frames.push(initial.value);
  for (;;) {
    const result = await stream.next();
    if (result.done) break;
    frames.push(result.value);
  }
  expect(first).toBe('frame');
  if (protocol === 'ChatCompletions') {
    expect(initial.value).toMatchObject({ event: { id: 'resp_initial', model: 'served', created: 7, service_tier: 'fast', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] } });
    expect(frames.filter(frame => frame.type === 'event' && frame.event.choices?.some((choice: any) => choice.delta?.role === 'assistant'))).toHaveLength(1);
  } else {
    expect(initial.value).toMatchObject({ event: { type: 'message_start', message: { id: 'resp_initial', model: 'served', role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: 0, speed: 'fast' } } } });
    expect(frames.filter(frame => frame.type === 'event' && frame.event.type === 'message_start')).toHaveLength(1);
  }
});
