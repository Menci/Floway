// Wire schemas type the dashboard's acquisition, update, and heartbeat requests;
// zValidator rejects malformed bodies before they reach the handlers.

import { z } from 'zod';

import { agentSetupConfigurationSchema } from './configuration.ts';

// Acquisition names the selected API key but carries no origin; the dashboard's
// one-line command injects that at execution time.
export const agentSetupCreateBody = z.object({
  apiKeyId: z.string().min(1),
});

// `expectedRevision` drives the optimistic-concurrency check on update.
export const agentSetupUpdateBody = z.object({
  token: z.string().min(1),
  configuration: agentSetupConfigurationSchema,
  expectedRevision: z.number().int().nonnegative(),
});

export const agentSetupHeartbeatBody = z.object({
  token: z.string().min(1),
});
