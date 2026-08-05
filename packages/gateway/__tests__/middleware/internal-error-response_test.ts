import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import { internalErrorResponse } from '../../src/middleware/internal-error-response.ts';

interface InternalErrorBody {
  error: {
    cause: unknown;
  };
}

const requestError = async (error: Error): Promise<InternalErrorBody> => {
  const app = new Hono().onError(internalErrorResponse);
  app.get('/failure', () => {
    throw error;
  });
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await app.request('/failure');
    expect(response.status).toBe(500);
    return await response.json() as InternalErrorBody;
  } finally {
    consoleSpy.mockRestore();
  }
};

test('internal error response terminates a self-referential Error cause', async () => {
  const error = new Error('self-referential failure');
  error.cause = error;

  const body = await requestError(error);

  expect(body.error.cause).toMatchObject({
    type: 'circular_reference',
    name: 'Error',
    message: 'self-referential failure',
  });
});

test('internal error response terminates a mutual Error cause cycle after preserving both errors', async () => {
  const outer = new Error('outer failure');
  const inner = new TypeError('inner failure', { cause: outer });
  outer.cause = inner;

  const body = await requestError(outer);

  expect(body.error.cause).toMatchObject({
    name: 'TypeError',
    message: 'inner failure',
    cause: {
      type: 'circular_reference',
      name: 'Error',
      message: 'outer failure',
    },
  });
});

test('internal error response bounds an adversarially deep Error cause chain', async () => {
  let error = new Error('leaf failure');
  for (let depth = 0; depth < 256; depth++) {
    error = new Error(`failure at depth ${depth}`, { cause: error });
  }

  const body = await requestError(error);
  let cause = body.error.cause;
  let serializedDepth = 0;
  while (typeof cause === 'object' && cause !== null && !('type' in cause)) {
    serializedDepth += 1;
    cause = (cause as { cause?: unknown }).cause;
  }

  expect(serializedDepth).toBe(32);
  expect(cause).toMatchObject({
    type: 'depth_limit',
    limit: 32,
    name: 'Error',
  });
});

test('internal error response snapshots a cause whose toJSON is only safe once', async () => {
  let calls = 0;
  const cause = {
    toJSON() {
      calls += 1;
      if (calls > 1) throw new Error('toJSON called twice');
      return { detail: 'stable snapshot' };
    },
  };

  const body = await requestError(new Error('outer failure', { cause }));

  expect(calls).toBe(1);
  expect(body.error.cause).toEqual({ detail: 'stable snapshot' });
});

test('internal error response marks a cause that cannot be serialized or printed', async () => {
  const cause = {
    toJSON() {
      throw new Error('serialization denied');
    },
    toString() {
      throw new Error('string conversion denied');
    },
  };

  const body = await requestError(new Error('outer failure', { cause }));

  expect(body.error.cause).toEqual({ type: 'unserializable_cause' });
});
