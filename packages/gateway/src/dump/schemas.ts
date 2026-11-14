import { z } from 'zod';

import { dumpMetadataSchema } from '@floway-dev/dump/schemas';

export const persistedDumpMetadataSchema = dumpMetadataSchema.omit({ upstream: true });

export const dumpHeadersSchema = z.array(z.tuple([z.string(), z.string()]));

export const dumpBodyDescriptorSchema = z.object({
  key: z.string(),
  type: z.enum(['bytes', 'events', 'run', 'capture']),
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
