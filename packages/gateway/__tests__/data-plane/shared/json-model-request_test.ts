import { expect, test, vi } from 'vitest';

import { prepareJsonModelRequest } from '../../../src/data-plane/shared/json-model-request.ts';

test('model request JSON distinguishes malformed input from a parser defect', () => {
  const bytes = new TextEncoder().encode('{');
  expect(prepareJsonModelRequest(bytes, 'Model')).toEqual({
    type: 'invalid',
    message: 'Model request body must be valid JSON.',
  });

  const defect = new TypeError('unexpected parser failure');
  const parser = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw defect; });
  try {
    expect(() => prepareJsonModelRequest(bytes, 'Model')).toThrow(defect);
  } finally {
    parser.mockRestore();
  }
});
