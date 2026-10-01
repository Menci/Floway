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
  // Time to first token in milliseconds. Null on non-streaming responses,
  // turns failed before any output token arrived, prewarm answers, and
  // records written before this field was introduced.
  ttftMs: z.number().nullish(),
  error: dumpErrorSchema.nullable(),
  // The target protocol a translated turn spoke to its upstream. Null on
  // native turns (no translation) and on records written before this field.
  // `.nullish()` so old `meta_json` rows missing the key still parse.
  targetApi: z.enum(['anthropicMessages', 'openaiResponses', 'openaiChatCompletions']).nullish(),
}).strict();

export const persistedDumpMetadataSchema = dumpMetadataSchema.omit({ upstream: true });

export const dumpBodyDescriptorSchema = z.object({
  key: z.string(),
  type: z.literal('run'),
}).strict();

export const dumpBrokerFrameSchema = z.object({
  event: z.literal('appended'),
  data: dumpMetadataSchema,
}).strict();
