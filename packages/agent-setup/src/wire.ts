// Wire schemas for the authenticated control-plane routes. zValidator rejects a
// malformed body before it reaches a handler, and the Hono RPC client reads
// these to type the dashboard's `$put` / `heartbeat.$post` request shapes.

import { z } from 'zod';

import { agentSetupConfigurationSchema } from './configuration.ts';

// Acquisition names the selected API key but carries no origin; the dashboard's
// one-line command injects that at execution time. `expectedRevision` drives the
// optimistic-concurrency check on PUT.
export const agentSetupCreateBody = z.object({
  apiKeyId: z.string().min(1),
});

export const agentSetupUpdateBody = z.object({
  token: z.string().min(1),
  configuration: agentSetupConfigurationSchema,
  expectedRevision: z.number().int().nonnegative(),
});

export const agentSetupHeartbeatBody = z.object({
  token: z.string().min(1),
});
