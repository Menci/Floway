import { expect, test } from 'vitest';

import { collect, completeIR, iterate } from './helpers.ts';
import { irFromOpenAIResponses } from '../../../src/shared/ir/sse-from/openai-responses/index.ts';
import { anthropicMessagesFromIR } from '../../../src/shared/ir/sse-to/anthropic-messages/index.ts';
import { geminiGenerateContentFromIR } from '../../../src/shared/ir/sse-to/gemini-generatecontent/index.ts';
import { openaiChatCompletionsFromIR } from '../../../src/shared/ir/sse-to/openai-chat-completions/index.ts';
import type { IRFrame, IRPath } from '../../../src/shared/ir/stream.ts';
import { eventFrame } from '@floway-dev/protocols/common';

const writers = [
  ['ChatCompletions', openaiChatCompletionsFromIR],
  ['Messages', anthropicMessagesFromIR],
  ['GenerateContent', geminiGenerateContentFromIR],
] as const;

const changes: [string, IRPath, any][] = [
  ['replace text', ['choices', 0, 'items', 0, 'summary', 0], 'replacement'],
  ['clear text', ['choices', 0, 'items', 0, 'summary', 0], ''],
  ['remove summary entry', ['choices', 0, 'items', 0, 'summary'], []],
  ['remove summary field', ['choices', 0, 'items', 0], { type: 'reasoning' }],
  ['remove item', ['choices', 0, 'items'], []],
];

for (const [name, writer] of writers) {
  test.each(changes)(`${name} rejects %s after reasoning has been emitted and closed`, async (_change, path, value) => {
    const frames = completeIR([{ type: 'reasoning', summary: ['visible'] }]);
    frames[0].records.splice(2, 0, { type: 'item_end', choice: 0, item: 0 }, { type: 'operation', operation: 'assign', path, value });
    const observed: any[] = [];
    const consume = async () => { for await (const frame of writer(iterate(frames))) observed.push(frame); };
    await expect(consume()).rejects.toThrow('cannot replace emitted text');
    expect(JSON.stringify(observed)).toContain('visible');
    expect(JSON.stringify(observed)).not.toContain('replacement');
  });
  test(`${name} rejects removal of an already closed text part`, async () => {
    const frames = completeIR([{ type: 'message', content: [{ type: 'text', text: 'visible' }] }]);
    frames[0].records.splice(2, 0, { type: 'part_end', choice: 0, item: 0, part: 0 }, { type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 0, 'content'], value: [] });
    await expect(collect<any>(writer(iterate(frames)))).rejects.toThrow('cannot replace emitted text');
  });
  test(`${name} rejects a final Responses summary snapshot deleting visible reasoning`, async () => {
    const item = { type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: 'visible' }] };
    const response = { id: 'resp', model: 'served', created_at: 1, status: 'in_progress', output: [], usage: null };
    const frames = [
      { type: 'response.created', response },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item: { ...item, summary: [] } },
      { type: 'response.completed', response: { ...response, status: 'completed', output: [{ ...item, summary: [] }] } },
    ].map(event => eventFrame(event as any));
    await expect(collect<any>(writer(irFromOpenAIResponses(iterate(frames))))).rejects.toThrow('cannot replace emitted text');
  });
}

test.each([{ summary: [] }, { summary: ['replacement'] }])('GenerateContent reconciles buffered Responses reasoning before its preceding tool finishes: $summary', async ({ summary }) => {
  const tool = { type: 'function_call', id: 'fc', call_id: 'call', name: 'tool', arguments: '', status: 'in_progress' };
  const reasoning = { type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: 'discarded' }] };
  const finalReasoning = { ...reasoning, summary: summary.map(text => ({ type: 'summary_text', text })) };
  const finalTool = { ...tool, arguments: '{}', status: 'completed' };
  const response = { id: 'resp', model: 'served', created_at: 1, status: 'in_progress', output: [], usage: null };
  const frames = [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item: tool },
    { type: 'response.output_item.added', output_index: 1, item: reasoning },
    { type: 'response.output_item.done', output_index: 1, item: finalReasoning },
    { type: 'response.output_item.done', output_index: 0, item: finalTool },
    { type: 'response.completed', response: { ...response, status: 'completed', output: [finalTool, finalReasoning] } },
  ].map(event => eventFrame(event as any));
  const output = await collect(geminiGenerateContentFromIR(irFromOpenAIResponses(iterate(frames))));
  const parts = output.flatMap(frame => (frame.event as any).candidates?.flatMap((candidate: any) => candidate.content?.parts ?? []) ?? []);
  expect(parts[0]).toMatchObject({ functionCall: { id: 'call', name: 'tool', args: {} } });
  expect(parts.filter((part: any) => part.thought).map((part: any) => part.text)).toEqual(summary);
  expect(JSON.stringify(output)).not.toContain('discarded');
});

test('a buffered deletion does not invalidate already-emitted unchanged reasoning', async () => {
  const frames: IRFrame[] = completeIR([{ type: 'reasoning', summary: ['visible'] }, { type: 'function_call', name: 'tool', call_id: 'call', arguments: '' }, { type: 'reasoning', summary: ['buffered'] }]);
  frames[0].records.splice(2, 0,
    { type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 2, 'summary'], value: [] },
    { type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 1, 'arguments'], value: '{}' },
    { type: 'item_end', choice: 0, item: 1 });
  const output = await collect(geminiGenerateContentFromIR(iterate(frames)));
  expect(JSON.stringify(output)).toContain('visible');
  expect(JSON.stringify(output)).not.toContain('buffered');
});
