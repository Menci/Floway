import type { Context } from 'hono';

const serializeErrorCause = (cause: unknown): unknown => {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      stack: cause.stack,
      cause: serializeErrorCause(cause.cause),
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
  console.error(error);

  return c.json(
    {
      error: {
        type: 'internal_error',
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: serializeErrorCause(error.cause),
        method: c.req.method,
        path: c.req.path,
      },
    },
    500,
  );
};
