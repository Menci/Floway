import type { Context } from 'hono';

import { isPublicSetupScriptRequest, redactSetupTokenPath } from './request-path.ts';

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
  // A failure while serving a public Agent Setup script must reveal nothing: the
  // thrown error can carry the selected API key or any other secret, so for
  // those exact GET/HEAD routes both the log line and the body are stripped
  // rather than scrubbed — the leaked secret is arbitrary, not just the token.
  if (isPublicSetupScriptRequest(c.req.method, c.req.path)) {
    console.error(`Internal error while serving a public Agent Setup script (${c.req.method})`);
    return c.json({ error: { type: 'internal_error' } }, 500);
  }

  // Every other route keeps the full stack trace; the path still runs through
  // the shared redactor so a near-miss setup path can't echo a token.
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
        path: redactSetupTokenPath(c.req.path),
      },
    },
    500,
  );
};
