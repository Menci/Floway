import { expect, test } from 'vitest';

import type { IRInputRequestHeader } from '../../src/ir/input/types.ts';
import { consumeIRRecords, type IRRecord } from '../../src/ir/output/stream.ts';
import { anthropicMessagesTargetProtocol } from '../../src/protocols/anthropic-messages/as-target.ts';
import { openaiChatCompletionsTargetProtocol } from '../../src/protocols/openai-chat-completions/as-target.ts';
import { iterate } from '../ir/helpers.ts';
import { fixtureFrames } from '../ir/translation-cases.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import { createRoundTripReaderCapture } from '../round-trip/test-helpers.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const request = (namespace: string | undefined): IRInputRequestHeader => ({
  settings: { model: 'm', stream: true },
  tools: [{ type: 'function', namespace, name: 'edit', parameters: { type: 'object', properties: {} } }, { type: 'custom', namespace, name: 'edit' }],
});

const expectOriginalCalls = async (records: AsyncIterable<IRRecord>, namespace: string | undefined): Promise<void> => {
  let completed = false;
  for await (const { record, collector } of consumeIRRecords(records)) {
    if (record.type !== 'finish') continue;
    completed = true;
    const items = collector.state.choices[0].items;
    expect(items).toMatchObject([
      { type: 'function_call', name: 'edit', arguments: '{}' },
      { type: 'custom_tool_call', name: 'edit', input: 'raw' },
    ]);
    for (const item of items) {
      if (namespace === undefined) expect(item).not.toHaveProperty('namespace');
      else expect(item).toHaveProperty('namespace', namespace);
    }
  }
  expect(completed).toBe(true);
};

test.each([undefined, 'files'])('Chat restores callable names and kinds in namespace %s while retaining native aliases', async namespace => {
  const written = openaiChatCompletionsTargetProtocol.write(request(namespace), [], { sidecarCodec: createTestSidecarCodec() });
  const names = written.payload.tools?.flatMap(tool => tool.type === 'function' ? [tool.function.name] : []);
  expect(names).toHaveLength(2);
  const [functionName, customName] = names!;
  expect(functionName).not.toBe(customName);
  const frames: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [eventFrame({
    id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{
      index: 0, delta: {
        role: 'assistant', tool_calls: [
          { index: 0, id: 'f', type: 'function', function: { name: functionName, arguments: '{}' } },
          { index: 1, id: 'c', type: 'function', function: { name: customName, arguments: '{"input":"raw"}' } },
        ],
      }, finish_reason: 'tool_calls',
    }],
  }), doneFrame()];
  const capture = createRoundTripReaderCapture<'openaiChatCompletions'>();
  await expectOriginalCalls(openaiChatCompletionsTargetProtocol.readStream(iterate(frames), written.context, capture.roundTrip), namespace);
  expect(capture.turns.get(0)?.turn.tool_calls).toMatchObject([
    { function: { name: functionName } }, { function: { name: customName } },
  ]);
});

test.each([undefined, 'files'])('Messages restores callable names and kinds in namespace %s while retaining native aliases', async namespace => {
  const written = anthropicMessagesTargetProtocol.write(request(namespace), [], { sidecarCodec: createTestSidecarCodec() });
  const names = written.payload.tools?.flatMap(tool => 'name' in tool ? [tool.name] : []);
  expect(names).toHaveLength(2);
  const [functionName, customName] = names!;
  expect(functionName).not.toBe(customName);
  const ordinary = fixtureFrames('anthropic-messages', {});
  const frames: ProtocolFrame<AnthropicMessagesStreamEventEx>[] = [
    ...ordinary.filter(frame => frame.type === 'event' && frame.event.type === 'message_start'),
    eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'f', name: functionName, input: {} } }),
    eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }),
    eventFrame({ type: 'content_block_stop', index: 0 }),
    eventFrame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c', name: customName, input: {} } }),
    eventFrame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"input":"raw"}' } }),
    eventFrame({ type: 'content_block_stop', index: 1 }),
    ...ordinary.filter(frame => frame.type === 'event' && (frame.event.type === 'message_delta' || frame.event.type === 'message_stop')),
  ];
  const capture = createRoundTripReaderCapture<'anthropicMessages'>();
  await expectOriginalCalls(anthropicMessagesTargetProtocol.readStream(iterate(frames), written.context, capture.roundTrip), namespace);
  expect(capture.turns.get(0)?.turn.content).toMatchObject([
    { type: 'tool_use', name: functionName }, { type: 'tool_use', name: customName },
  ]);
});
