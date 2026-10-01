import { expect, test } from 'vitest';

import { emitAnthropicMessages } from '../../../src/data-plane/chat/anthropic-messages/emit.ts';
import { emitGeminiGenerateContent } from '../../../src/data-plane/chat/gemini-generate-content/emit.ts';
import { emitOpenAIChatCompletions } from '../../../src/data-plane/chat/openai-chat-completions/emit.ts';
import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { openRunDump } from '../../../src/dump/run-sink.ts';
import type { ApiKey } from '../../../src/repo/types.ts';
import { eventsOf, installDumpStubs } from '../../dump/test-fixtures.ts';
import { flushBackground, trackBackground } from '../../test-utils/background-tracker.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { compose, createRunReader, defineStage, move, run, type DumpEvent } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const key: ApiKey = { id: 'client-key', userId: 1, name: 'Client key', key: 'client-key', serverSecret: '00'.repeat(32), createdAt: '2026-01-01T00:00:00Z', upstreamIds: null, deletedAt: null, dumpRetentionSeconds: 3600, openaiResponsesRetentionSeconds: 0 };
const usage: OpenAIChatCompletionsStreamEvent = { id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'model', choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
const chat: OpenAIChatCompletionsStreamEvent = { id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'model', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }] };
const citation: AnthropicMessagesStreamEvent = {
  type: 'content_block_start', index: 0,
  content_block: {
    type: 'text', text: 'answer',
    citations: [{ type: 'search_result_location', url: 'https://example.com/source', title: 'Source', search_result_index: 0, start_block_index: 0, end_block_index: 1 }],
  },
};
const gemini: GeminiGenerateContentStreamEvent = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] };

const cases = [
  ...[false, true].flatMap(includeUsage => [false, true].map(done => ({
    name: `Chat Completions ${includeUsage ? 'included' : 'hidden'} usage with ${done ? 'DONE' : 'normal EOF'}`,
    emit: emitOpenAIChatCompletions,
    entry: { 'ingress.chat.openaiChatCompletions.wantsStream': true, 'ingress.chat.openaiChatCompletions.wantsUsageChunk': includeUsage },
    response: 'response.chat.openaiChatCompletions', rendered: 'response.chat.openaiChatCompletions.rendered',
    upstream: [eventFrame(chat), eventFrame(usage), ...(done ? [doneFrame()] : [])],
    verify: (events: unknown[]) => {
      expect(events.some(event => typeof event === 'object' && event !== null && 'usage' in event)).toBe(includeUsage);
      expect(events.includes('[DONE]')).toBe(done);
    },
  }))),
  {
    name: 'Anthropic citations and transport terminator', emit: emitAnthropicMessages,
    entry: { 'ingress.chat.anthropicMessages.wantsStream': true },
    response: 'response.chat.anthropicMessages', rendered: 'response.chat.anthropicMessages.rendered',
    upstream: [eventFrame(citation), eventFrame<AnthropicMessagesStreamEvent>({ type: 'content_block_stop', index: 0 }), eventFrame<AnthropicMessagesStreamEvent>({ type: 'message_stop' }), doneFrame()],
    verify: (events: unknown[]) => {
      expect(events).not.toContain('[DONE]');
      expect(events).toContainEqual({ ...citation, index: 1, content_block: { type: 'text', text: 'answer', citations: [{ type: 'search_result_location', source: 'https://example.com/source', title: 'Source', search_result_index: 0, start_block_index: 0, end_block_index: 1 }] } });
    },
  },
  {
    name: 'Gemini transport terminator', emit: emitGeminiGenerateContent,
    entry: { 'ingress.chat.geminiGenerateContent.wantsStream': true },
    response: 'response.chat.geminiGenerateContent', rendered: 'response.chat.geminiGenerateContent.rendered',
    upstream: [eventFrame(gemini), doneFrame()],
    verify: (events: unknown[]) => { expect(events).not.toContain('[DONE]'); expect(events).toMatchObject([gemini]); },
  },
];

for (const fixture of cases) {
  test(`selected recorded client protocol frames equal actual SSE for ${fixture.name}`, async () => {
    const stubs = installDumpStubs(initDumpStore, initDumpBroker);
    const dump = openRunDump(key, { method: 'POST', path: '/v1/chat', body: { bytes: new Uint8Array(), streamError: null } }, trackBackground, true, { upstreamCallStartedAt: null, firstOutputTokenAt: null });
    if (dump === null) throw new Error('retained client request has no run recording');
    const dial = defineStage<Record<string, unknown>, Record<string, unknown>>({
      name: 'scriptedDial', return: { provides: [fixture.response, 'response.http.headers', 'response.http.status', `${fixture.response}.streamedUsage`] },
      execute: async facts => move({
        ...facts, 'response.http.headers': [], 'response.http.status': 200, [`${fixture.response}.streamedUsage`]: null,
        [fixture.response]: { kind: 'stream', frames: { async *[Symbol.asyncIterator]() { yield* fixture.upstream; } } },
      }),
    });
    const outcome = await run(compose<Record<string, unknown>, Record<string, unknown>>('clientStream', [fixture.emit, dial]), move(fixture.entry), { gateway: mockChatGatewayCtx({ dump, wantsStream: true }), dump: dump.sink });
    const wire: unknown[] = [];
    for await (const frame of outcome.facts[fixture.rendered] as AsyncIterable<SseFrame>) wire.push(frame.data === '[DONE]' ? frame.data : JSON.parse(frame.data));
    await outcome.drain();
    dump.finalize(200, 0);
    await flushBackground();
    const read = createRunReader();
    const streams = new Map<number, ProtocolFrame<unknown>[]>();
    let client: number | null = null;
    const record = stubs.stored[0]?.record;
    if (record === undefined) throw new Error('completed client stream has no persisted record');
    for (const item of eventsOf(record)) {
      const event = item as unknown as DumpEvent;
      const decoded = read(event);
      if (decoded?.facts && 'response.chat.clientFrames' in decoded.facts) client = (decoded.facts['response.chat.clientFrames'] as { stream: number }).stream;
      if (event.type === 'stream.frame') {
        const frames = streams.get(event.streamId) ?? [];
        frames.push(...decoded?.frames as ProtocolFrame<unknown>[]);
        streams.set(event.streamId, frames);
      }
    }
    const frames = client === null ? [] : streams.get(client) ?? [];
    expect(frames.length).toBeGreaterThan(0);
    const recorded = frames.map(frame => frame.type === 'done' ? '[DONE]' : frame.event);
    expect(recorded).toEqual(wire);
    expect(eventsOf(record).some(event => event.type === 'stream.end' && event.streamId === client)).toBe(true);
    expect(record.meta.error).toBeNull();
    fixture.verify(recorded);
  });
}
