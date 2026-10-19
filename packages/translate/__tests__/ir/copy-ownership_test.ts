import { expect, test } from 'vitest';

import { collect, irFromAnthropicMessages, irFromOpenAIChatCompletions, irFromOpenAIResponses, iterate } from './helpers.ts';
import { createIRCollector } from '../../src/ir/collector.ts';
import { consumeIRRecords, createIRBuilder } from '../../src/ir/stream.ts';
import { eventFrame } from '@floway-dev/protocols/common';

const initializeTextPart = (collector: ReturnType<typeof createIRCollector>, part: object): void => {
  collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } });
  collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'message', content: [] } });
  collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0, 'content', 0], value: part as any });
};

test('collectors borrow record trees and copy only containers first written by that collector', () => {
  const annotations = Object.freeze([{ type: 'source_citation', source_kind: 'url', source: 'https://example.com' }]);
  const part = Object.freeze({ type: 'text', text: '', annotations });
  const first = createIRCollector();
  const second = createIRCollector();
  initializeTextPart(first, part);
  initializeTextPart(second, part);
  expect(first.state.choices[0].items[0].type === 'message' && first.state.choices[0].items[0].content[0]).toBe(part);
  expect(second.state.choices[0].items[0].type === 'message' && second.state.choices[0].items[0].content[0]).toBe(part);

  first.apply({ type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'one' });
  const firstPart = first.state.choices[0].items[0].type === 'message' ? first.state.choices[0].items[0].content[0] : undefined;
  expect(firstPart).not.toBe(part);
  expect(firstPart?.type === 'text' && firstPart.annotations).toBe(annotations);
  expect(second.state.choices[0].items[0].type === 'message' && second.state.choices[0].items[0].content[0]).toBe(part);

  second.apply({ type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'other' });
  expect(first.value(['choices', 0, 'items', 0, 'content', 0, 'text'])).toBe('one');
  expect(second.value(['choices', 0, 'items', 0, 'content', 0, 'text'])).toBe('other');
  expect(part.text).toBe('');
});

test('builder transfers payloads without copying and later operations never modify their records', async () => {
  const builder = createIRBuilder();
  const choice = Object.freeze({ items: Object.freeze([]) });
  const item = Object.freeze({ type: 'message', content: Object.freeze([]) });
  const part = Object.freeze({ type: 'text', text: '' });
  builder.initialize(['choices', 0], choice);
  builder.assign(['model'], 'example');
  builder.event({ type: 'start', id: 'example' });
  builder.initialize(['choices', 0, 'items', 0], item);
  builder.initialize(['choices', 0, 'items', 0, 'content', 0], part);
  builder.append(['choices', 0, 'items', 0, 'content', 0, 'text'], 'hello');
  builder.event({ type: 'part_end', choice: 0, item: 0, part: 0 });
  builder.event({ type: 'item_end', choice: 0, item: 0 });
  builder.event({ type: 'choice_end', choice: 0, finish_reason: 'stop' });
  builder.event({ type: 'finish', status: 'completed' });
  const records = builder.drain();
  expect(records[0].type === 'write' && records[0].value).toBe(choice);
  expect(records[3].type === 'write' && records[3].value).toBe(item);
  expect(records[4].type === 'write' && records[4].value).toBe(part);
  const results = await collect(consumeIRRecords(iterate(records)));
  expect(results.at(-1)!.collector.state).toEqual(builder.state);
  expect(choice.items).toEqual([]);
  expect(item.content).toEqual([]);
  expect(part.text).toBe('');
});

test('array writes copy the array while retaining immutable sibling values', () => {
  const sibling = Object.freeze({ items: Object.freeze([]) });
  const collector = createIRCollector();
  collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 0], value: sibling });
  const preceding = collector.state.choices;
  collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 1], value: { items: [] } });
  expect(collector.state.choices).toBe(preceding);
  expect(collector.state.choices[0]).toBe(sibling);
  const owned = collector.state.choices;
  collector.apply({ type: 'write', kind: 'initialize', path: ['choices', 2], value: { items: [] } });
  expect(collector.state.choices).toBe(owned);
});

test('value exposes the accumulator live readonly view', () => {
  const collector = createIRCollector();
  collector.apply({ type: 'write', kind: 'initialize', path: ['usage'], value: {} });
  const value = collector.value<Record<string, number>>(['usage'])!;
  collector.apply({ type: 'write', kind: 'assign', path: ['usage', 'output_tokens_inclusive'], value: 1 });
  expect(value).toEqual({});
  expect(collector.value(['usage'])).toEqual({ output_tokens_inclusive: 1 });
});

test.each([
  ['ChatCompletions', irFromOpenAIChatCompletions, (error: object) => ({ id: 'chat', model: 'm', choices: [], error })],
  ['Responses', irFromOpenAIResponses, (error: object) => ({ type: 'error', error })],
  ['Messages', irFromAnthropicMessages, (error: object) => ({ type: 'error', error })],
] as const)('%s reader transfers immutable error objects without copying', async (_name, reader, event) => {
  const error = Object.freeze({ type: 'api_error', message: 'original', details: Object.freeze([Object.freeze({ text: 'original' })]) });
  const frames = await collect(reader(iterate([eventFrame(event(error) as any)])));
  const record = frames.find(record => record.type === 'error');
  expect(record?.error).toBe(error);
});
