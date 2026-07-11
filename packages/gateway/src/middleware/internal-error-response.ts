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
  // A failure while serving a public Agent Setup script must reveal nothing.
  // The request path carries the lease token, the thrown error can carry the
  // selected API key or any other secret in its message/stack, and the same
  // object would otherwise be written to the server log by console.error. So
  // for those exact GET/HEAD routes we log a marker with no error detail and
  // return an opaque internal error. Redaction is not enough here — the leaked
  // secret is arbitrary, not just the token in the path — so the whole body and
  // the log line are stripped rather than scrubbed.
  if (isPublicSetupScriptRequest(c.req.method, c.req.path)) {
    console.error(`Internal error while serving a public Agent Setup script (${c.req.method})`);
    return c.json({ error: { type: 'internal_error' } }, 500);
  }

  // Every other route keeps the full stack trace that makes gateway failures
  // debuggable; the path still runs through the shared redactor so a near-miss
  // setup path (wrong-length token, still script-shaped) can't echo a token.
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
