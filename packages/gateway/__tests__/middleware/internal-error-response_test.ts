import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
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

test('explicit HTTP errors preserve status, body, exception headers, and staged context headers without logging', async () => {
  const app = new Hono().onError(internalErrorResponse);
  app.get('/failure', c => {
    c.header('x-staged', 'kept');
    throw new HTTPException(422, {
      res: new Response('invalid', { headers: { 'x-exception': 'kept' } }),
    });
  });
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await app.request('/failure');
    expect(response.status).toBe(422);
    expect(await response.text()).toBe('invalid');
    expect(response.headers.get('x-staged')).toBe('kept');
    expect(response.headers.get('x-exception')).toBe('kept');
    expect(consoleSpy).not.toHaveBeenCalled();
  } finally {
    consoleSpy.mockRestore();
  }
});
