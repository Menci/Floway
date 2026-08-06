import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { RequestBodyTooLargeError } from './request-body-limit.ts';

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
    const encoded = JSON.stringify(cause);
    if (encoded !== undefined) return JSON.parse(encoded) as unknown;
  } catch {
    // Fall through to a printable scalar when the value is cyclic or exposes a
    // hostile serializer. Returning the original would invoke it again in c.json.
  }
  try {
    return String(cause);
  } catch {
    return { type: 'unserializable_cause' };
  }
};

export const internalErrorResponse = (error: Error, c: Context): Response => {
  if (error instanceof RequestBodyTooLargeError) {
    return c.json({
      error: {
        type: 'request_too_large',
        message: error.message,
        max_bytes: error.maxBytes,
        ...(error.maxBytesWithContentLength === null
          ? {}
          : { max_bytes_with_content_length: error.maxBytesWithContentLength }),
        method: c.req.method,
        path: c.req.path,
      },
    }, 413);
  }
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
