import { expect, test, vi } from 'vitest';

import { parseJSONObject, parseJSONObjectAtCompletion } from '../../../src/shared/json/object.ts';

test('default object parsing preserves number tokens that would serialize differently', () => {
  const source = '{"rounded":0.10000000000000001,"negativeZero":-0,"canonical":1.25}';

  expect(JSON.stringify(parseJSONObject(source))).toBe(source);
});

test('truncated JSON completion does not invoke the parser', () => {
  const parser = vi.fn(() => ({ repaired: true }));
  expect(parseJSONObjectAtCompletion('{"value":', 'truncated', parser)).toEqual({ completion: 'truncated' });
  expect(parser).not.toHaveBeenCalled();
});

test('complete JSON completion uses repair and still requires an object', () => {
  expect(parseJSONObjectAtCompletion('{"value":', 'complete', text => JSON.parse(`${text}1}`))).toEqual({
    completion: 'complete',
    value: { value: 1 },
  });
  expect(() => parseJSONObjectAtCompletion('[]', 'complete')).toThrow('Tool arguments require a JSON object');
});
