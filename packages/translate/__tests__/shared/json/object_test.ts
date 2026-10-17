import { expect, test, vi } from 'vitest';

import { parseJSONObjectAtCompletion } from '../../../src/shared/json/object.ts';

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
