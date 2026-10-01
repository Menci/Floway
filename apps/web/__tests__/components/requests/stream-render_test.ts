import { expect, test } from 'vitest';

import { clientStreamOf } from '../../../src/components/requests/run-stream';
import { collectStream, renderStreamEvents, streamEventsCopyText } from '../../../src/components/requests/stream-render';
import { encodeRun, streamFact, toNdjson, type Event } from '@floway-dev/pipeline';
import { anthropicMessagesEventToSsePayload, type AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';

const recorded = (frames: readonly ProtocolFrame<unknown>[], ended: boolean) => {
  const events: Event[] = [
    { type: 'stage.entered', stageId: 1, name: 'emit', parentStageId: null, facts: {} },
    { type: 'stage.leaved', stageId: 1, facts: { 'response.chat.clientFrames': streamFact(1) } },
    { type: 'stream.frame', streamId: 1, frames },
    ...ended ? [{ type: 'stream.end' as const, streamId: 1 }] : [],
  ];
  return clientStreamOf(toNdjson(encodeRun(events)))!;
};

const chunk = eventFrame({ id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] });

test('collects normal Chat Completions EOF without inventing a done frame', async () => {
  const stream = recorded([chunk], true);
  const collected = await collectStream('openai-chat-completions', stream);
  expect(collected).toMatchObject({ result: { choices: [{ message: { content: 'hello' } }] }, error: null, truncated: false });
  expect(stream.events).toHaveLength(1);
  expect(streamEventsCopyText('openai-chat-completions', stream.events)).not.toContain('[DONE]');
});

for (const terminal of [false, true]) {
  test(`marks an interrupted recording incomplete even with ${terminal ? 'a terminal frame' : 'partial output'}`, async () => {
    const stream = recorded([chunk, ...terminal ? [{ type: 'done' as const }] : []], false);
    expect(await collectStream('openai-chat-completions', stream)).toMatchObject({ error: null, truncated: true });
  });
}

test('separates an ended protocol error from a truncated recording', async () => {
  const stream = recorded([eventFrame({ type: 'error', error: { type: 'api_error', message: 'upstream failed' } })], true);
  expect(await collectStream('anthropic-messages', stream)).toMatchObject({ result: null, error: expect.stringContaining('upstream failed'), truncated: false });
});

test('renders and copies final Anthropic citation wire fields once while collecting the canonical result', async () => {
  const citation = { type: 'search_result_location' as const, url: 'https://example.com/source', title: 'Reference', search_result_index: 0, start_block_index: 0, end_block_index: 1, cited_text: 'evidence' };
  const events: AnthropicMessagesStreamEvent[] = [
    { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', content: [], model: 'm', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'answer', citations: [citation] } },
    { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  const wire = events.map(event => eventFrame(anthropicMessagesEventToSsePayload(event)));
  const stream = recorded(wire, true);
  const rendered = renderStreamEvents('anthropic-messages', stream.events);
  expect(JSON.parse(rendered[1]!.text)).toEqual(wire[1]!.event);
  expect(JSON.parse(rendered[2]!.text)).toEqual(wire[2]!.event);
  const copied = streamEventsCopyText('anthropic-messages', stream.events);
  expect(copied).toContain('"source":"https://example.com/source"');
  expect(copied).not.toContain('"url"');
  expect(await collectStream('anthropic-messages', stream)).toMatchObject({ result: { content: [{ type: 'text', text: 'answer', citations: [citation, citation] }] }, error: null, truncated: false });
});

test('collects the classic Completions stream published by its rendered fact', async () => {
  const stream = clientStreamOf(toNdjson(encodeRun([
    { type: 'stage.entered', stageId: 1, name: 'emitOpenAICompletions', parentStageId: null, facts: {} },
    { type: 'stream.frame', streamId: 4, frames: [eventFrame({ id: 'completion-1', object: 'text_completion', created: 1, model: 'm', choices: [{ index: 0, text: 'classic answer', finish_reason: 'stop', logprobs: null }] }), { type: 'done' }] },
    { type: 'stream.end', streamId: 4 },
    { type: 'stage.leaved', stageId: 1, facts: { 'response.openaiCompletions.rendered': streamFact(4) } },
  ])))!;
  expect(await collectStream('openai-completions', stream)).toMatchObject({ result: { choices: [{ text: 'classic answer' }] }, error: null, truncated: false });
});
