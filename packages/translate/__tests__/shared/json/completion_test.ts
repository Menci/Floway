import { expect, test } from 'vitest';

import { parseJSONObjectUnlessTruncated } from '../../../src/shared/json/completion.ts';

test('complete JSON completion uses repair and still requires an object', () => {
  expect(parseJSONObjectUnlessTruncated('{"value":', 'complete', text => JSON.parse(`${text}1}`))).toEqual({
    completion: 'complete',
    value: { value: 1 },
  });
  expect(() => parseJSONObjectUnlessTruncated('[]', 'complete')).toThrow('Tool arguments require a JSON object');
});
