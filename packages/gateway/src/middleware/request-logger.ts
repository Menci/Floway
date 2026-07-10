import type { Next } from 'hono';

import { type AuthedContext } from './auth.ts';
import { redactSetupTokenPath } from './request-path.ts';

// Request logger replacing hono/logger so the setup-script token never reaches
// a log line. The path is scrubbed through the shared redactor before it is
// logged; every non-setup path passes through unchanged, so ordinary routes log
// exactly as before. One line per request, emitted on completion with the
// method, redacted path, status, and elapsed milliseconds.
export const requestLogger = async (c: AuthedContext, next: Next): Promise<void> => {
  const start = Date.now();
  await next();
  const elapsedMs = Date.now() - start;
  console.log(`${c.req.method} ${redactSetupTokenPath(c.req.path)} ${c.res.status} ${elapsedMs}ms`);
};
