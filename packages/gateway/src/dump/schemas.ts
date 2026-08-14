import { z } from 'zod';

import { ALL_PROVIDER_KINDS } from '@floway-dev/provider';

export const dumpErrorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['upstream', 'gateway']) }).strict(),
  z.object({ kind: z.literal('failed'), reason: z.string() }).strict(),
]);

export const dumpUpstreamRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(ALL_PROVIDER_KINDS),
  hue: z.number(),
}).strict();

export const dumpMetadataSchema = z.object({
  id: z.string(),
  startedAt: z.number(),
  completedAt: z.number(),
  method: z.string(),
  path: z.string(),
  status: z.number().nullable(),
  upstream: dumpUpstreamRefSchema.nullable(),
  model: z.string().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  requestBytes: z.number(),
  responseBytes: z.number(),
  durationMs: z.number(),
  error: dumpErrorSchema.nullable(),
}).strict();

export const persistedDumpMetadataSchema = dumpMetadataSchema.omit({ upstream: true });

export const dumpHeadersSchema = z.array(z.tuple([z.string(), z.string()]));

export const dumpBodyDescriptorSchema = z.object({
  key: z.string(),
  type: z.enum(['bytes', 'events']),
}).strict();

const dumpProtocolFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: z.unknown() }).strict(),
  z.object({ type: z.literal('done') }).strict(),
]);

export const dumpStreamEventSchema = z.object({
  frame: dumpProtocolFrameSchema,
  ts: z.number(),
}).strict();

export const dumpStreamEventsSchema = z.array(dumpStreamEventSchema);

export const dumpBrokerFrameSchema = z.object({
  event: z.literal('appended'),
  data: dumpMetadataSchema,
}).strict();
