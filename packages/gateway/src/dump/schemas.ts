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
  // The target protocol a translated turn spoke to its upstream. Null on
  // native turns (no translation) and on records written before this field.
  // `.nullish()` so old `meta_json` rows missing the key still parse.
  targetApi: z.enum(['anthropicMessages', 'openaiResponses', 'openaiChatCompletions']).nullish(),
}).strict();

export const persistedDumpMetadataSchema = dumpMetadataSchema.omit({ upstream: true });

export const dumpHeadersSchema = z.array(z.tuple([z.string(), z.string()]));

export const dumpBodyDescriptorSchema = z.object({
  key: z.string(),
  type: z.enum(['bytes', 'events', 'capture']),
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

const rawBodySchema = z.object({
  encoding: z.enum(['utf8', 'base64']),
  data: z.string(),
}).strict();

const rawCaptureSchema = z.object({
  body: rawBodySchema,
  complete: z.boolean(),
  error: z.string().nullable(),
}).strict();

export const dumpCaptureSchema = z.object({
  exchanges: z.array(z.object({
    upstreamId: z.string(),
    request: z.object({
      url: z.string(),
      method: z.string(),
      headers: dumpHeadersSchema,
      body: rawBodySchema,
    }).strict(),
    response: rawCaptureSchema.extend({ status: z.number(), headers: dumpHeadersSchema }).nullable(),
    error: z.string().nullable(),
  }).strict()),
  response: rawCaptureSchema.optional(),
}).strict();

export const dumpCaptureEnvelopeSchema = z.object({
  version: z.literal(1),
  capture: dumpCaptureSchema,
  upstream: z.object({
    status: z.number().nullable(),
    headers: dumpHeadersSchema,
    body: z.discriminatedUnion('type', [
      z.object({ type: z.literal('stream'), events: dumpStreamEventsSchema }).strict(),
      z.object({ type: z.literal('bytes'), body: rawBodySchema }).strict(),
      z.object({ type: z.literal('none') }).strict(),
    ]),
  }).optional(),
}).strict();

export const dumpBrokerFrameSchema = z.object({
  event: z.literal('appended'),
  data: dumpMetadataSchema,
}).strict();
