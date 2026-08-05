import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

const MAX_SERIALIZED_ERROR_CAUSE_DEPTH = 32;

const serializedErrorIdentity = (error: Error) => ({
  name: error.name,
  message: error.message,
  stack: error.stack,
});

const serializeErrorCause = (cause: unknown, ancestors: ReadonlySet<Error>, depth = 0): unknown => {
  if (cause instanceof Error) {
    const identity = serializedErrorIdentity(cause);
    if (ancestors.has(cause)) {
      return { type: 'circular_reference', ...identity };
    }
    if (depth >= MAX_SERIALIZED_ERROR_CAUSE_DEPTH) {
      return { type: 'depth_limit', limit: MAX_SERIALIZED_ERROR_CAUSE_DEPTH, ...identity };
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(cause);
    return {
      ...identity,
      cause: serializeErrorCause(cause.cause, nextAncestors, depth + 1),
    };
  }

  if (cause === undefined || cause === null || typeof cause === 'string' || typeof cause === 'number' || typeof cause === 'boolean') return cause;

  try {
    JSON.stringify(cause);
    return cause;
  } catch {
    return String(cause);
  }
};

export const internalErrorResponse = (error: Error, c: Context): Response => {
  if (error instanceof HTTPException) {
    const response = error.getResponse();
    return c.newResponse(response.body, response);
  }

  console.error(error);

  return c.json(
    {
      error: {
        type: 'internal_error',
        ...serializedErrorIdentity(error),
        cause: serializeErrorCause(error.cause, new Set([error])),
        method: c.req.method,
        path: c.req.path,
      },
    },
    500,
  );
};
