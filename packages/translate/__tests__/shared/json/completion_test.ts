import { expect, test, vi } from 'vitest';

import { parseJSONObjectUnlessTruncated } from '../../../src/shared/json/completion.ts';

test('truncated JSON completion does not invoke the parser', () => {
  const parser = vi.fn(() => ({ repaired: true }));
  expect(parseJSONObjectUnlessTruncated('{"value":', 'truncated', parser)).toEqual({ completion: 'truncated' });
  expect(parser).not.toHaveBeenCalled();
});

test('complete JSON completion uses repair and still requires an object', () => {
  expect(parseJSONObjectUnlessTruncated('{"value":', 'complete', text => JSON.parse(`${text}1}`))).toEqual({
    completion: 'complete',
    value: { value: 1 },
  });
  expect(() => parseJSONObjectUnlessTruncated('[]', 'complete')).toThrow('Tool arguments require a JSON object');
});
