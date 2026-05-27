import { zValidator as zValidatorBase } from '@hono/zod-validator';
import type { Context, ValidationTargets } from 'hono';
import type { z, ZodType } from 'zod';

// Wrap @hono/zod-validator so validation failures return our canonical
// `{ error: msg }` 400 shape — matching what the hand-written control-plane
// validators returned before this change. Without the wrapper, zValidator's
// default response includes the full ZodError tree, which is too noisy for the
// dashboard's inline error UI and would force the SPA to learn a second error
// format.
export const zValidator = <T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidatorBase(target, schema, (result, c) => {
    if (!result.success) {
      // Take the first issue's message verbatim. Schemas attach field-aware
      // messages (e.g. "version must be 2") where they want to override
      // zod's default phrasing, so we don't prepend the path — that would
      // double up the field name in custom-message cases.
      const issue = result.error.issues[0];
      return c.json({ error: issue?.message ?? 'Invalid input' }, 400);
    }
  });

// Handler context aliases for routes whose request shape is declared via
// zValidator middleware. Handlers in separate files import these to type
// `c.req.valid('json' | 'query')` precisely without restating the env / path
// generics every time.
export type CtxWithJson<S extends ZodType> = Context<{ Variables: Record<string, unknown> }, string, { in: { json: z.infer<S> }; out: { json: z.infer<S> } }>;
export type CtxWithQuery<S extends ZodType> = Context<{ Variables: Record<string, unknown> }, string, { in: { query: z.infer<S> }; out: { query: z.infer<S> } }>;
