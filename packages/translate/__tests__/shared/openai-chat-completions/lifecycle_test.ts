import { expect, test, vi } from 'vitest';

import { createChatStreamLifecycle } from '../../../src/shared/openai-chat-completions/lifecycle.ts';

const lifecycle = () => createChatStreamLifecycle(() => { throw new Error('Unexpected closed tool delta'); });

test('reasoning, text, reasoning create distinct slots while consecutive fragments share their owner', () => {
  const stream = lifecycle();
  const first = stream.accept([{ kind: 'reasoning', text: 'A' }]);
  expect(first.map(event => event.type)).toEqual(['open', 'delta']);
  expect(stream.accept([{ kind: 'reasoning', text: 'B' }])).toEqual([{ type: 'delta', slot: first[0].slot, text: 'B' }]);
  expect(stream.accept([{ kind: 'text', text: 'answer' }]).map(event => [event.type, event.slot.index])).toEqual([['close', 0], ['open', 1], ['delta', 1]]);
  expect(stream.accept([{ kind: 'reasoning', text: 'C' }]).map(event => [event.type, event.slot.index])).toEqual([['close', 1], ['open', 2], ['delta', 2]]);
  expect(stream.finish().map(event => event.slot.index)).toEqual([2]);
});

test('unfinished tools remain active across text and other tools, then close at their JSON boundary', () => {
  const stream = lifecycle();
  stream.accept([{ kind: 'tool', index: 0, id: 'a', name: 'f', arguments: '{"a":' }]);
  expect(stream.accept([{ kind: 'text', text: 'live' }]).map(event => [event.type, event.slot.index])).toEqual([['open', 1], ['delta', 1]]);
  expect(stream.accept([{ kind: 'tool', index: 1, id: 'b', name: 'g', arguments: '{}' }]).map(event => [event.type, event.slot.index])).toEqual([['close', 1], ['open', 2], ['delta', 2], ['close', 2]]);
  expect(stream.accept([{ kind: 'tool', index: 0, arguments: '1}' }]).map(event => [event.type, event.slot.index])).toEqual([['delta', 0], ['close', 0]]);
  expect(stream.finish()).toEqual([]);
});

test('mixed chunks append to current and previous owners before opening new content', () => {
  const stream = lifecycle();
  stream.accept([{ kind: 'tool', index: 0, id: 'a', name: 'f', arguments: '{' }]);
  stream.accept([{ kind: 'reasoning', text: 'A' }]);
  expect(stream.accept([{ kind: 'text', text: 'X' }, { kind: 'tool', index: 0, arguments: '}' }, { kind: 'reasoning', text: 'B' }]).map(event => [event.type, event.slot.index])).toEqual([
    ['delta', 1], ['delta', 0], ['close', 0], ['close', 1], ['open', 2], ['delta', 2],
  ]);
});

test('JSON boundary recognition survives escaped quotes, braces in strings, and nested arrays across fragments', () => {
  const stream = lifecycle();
  const argumentsText = JSON.stringify({ text: 'quote" slash\\ } ]', nested: [{ ok: true }] });
  const events = [];
  for (const [index, char] of [...argumentsText].entries()) events.push(...stream.accept([{ kind: 'tool', index: 0, ...(index === 0 ? { id: 'a', name: 'f' } : {}), arguments: char }]));
  expect(events.filter(event => event.type === 'close')).toHaveLength(1);
  expect(events.at(-1)?.type).toBe('close');
});

test('arguments received before identity are emitted once when the tool can be opened', () => {
  const stream = lifecycle();
  expect(stream.accept([{ kind: 'tool', index: 0, arguments: '{}' }])).toEqual([]);
  expect(stream.accept([{ kind: 'tool', index: 0, id: 'a', name: 'f' }]).map(event => event.type)).toEqual(['open', 'delta', 'close']);
});

test('closed tool deltas warn and do not reopen or mutate their completed owner', () => {
  const warn = vi.fn();
  const stream = createChatStreamLifecycle(warn);
  stream.accept([{ kind: 'tool', index: 0, id: 'a', name: 'f', arguments: '{}' }]);
  expect(stream.accept([{ kind: 'tool', index: 0, arguments: 'late' }])).toEqual([]);
  expect(warn).toHaveBeenCalledWith(0);
});

test('finish closes every remaining owner in creation order, including incomplete tool arguments', () => {
  const stream = lifecycle();
  stream.accept([{ kind: 'tool', index: 0, id: 'a', name: 'f', arguments: '{' }]);
  stream.accept([{ kind: 'text', text: 'X' }]);
  expect(stream.finish().map(event => event.slot.index)).toEqual([0, 1]);
  expect(stream.finish()).toEqual([]);
});

test('malformed completed objects and non-object inputs expose their parse failure', () => {
  expect(() => lifecycle().accept([{ kind: 'tool', index: 0, id: 'a', name: 'f', arguments: '{"a":}' }])).toThrow(SyntaxError);
  expect(() => lifecycle().accept([{ kind: 'tool', index: 0, id: 'a', name: 'f', arguments: '[]' }])).toThrow('JSON object');
});

test('a late tool identity keeps its reserved order without stealing the current text owner', () => {
  const stream = lifecycle();
  stream.accept([{ kind: 'tool', index: 0, arguments: '{}' }]);
  expect(stream.accept([{ kind: 'text', text: 'A' }])[0].slot.index).toBe(1);
  expect(stream.accept([{ kind: 'tool', index: 0, id: 'a', name: 'f' }]).map(event => [event.type, event.slot.index])).toEqual([['open', 0], ['delta', 0], ['close', 0]]);
  expect(stream.accept([{ kind: 'text', text: 'B' }]).map(event => [event.type, event.slot.index])).toEqual([['delta', 1]]);
});
