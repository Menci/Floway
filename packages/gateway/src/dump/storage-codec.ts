import type { z } from 'zod';

import {
  dumpBodyDescriptorSchema,
  dumpHeadersSchema,
  persistedDumpMetadataSchema,
  dumpStreamEventsSchema,
} from './schemas.ts';
import type { DumpMetadata, DumpStreamEvent } from './types.ts';

export type DumpBodyDescriptor = z.infer<typeof dumpBodyDescriptorSchema>;
type PersistedDumpMetadata = z.infer<typeof persistedDumpMetadataSchema>;

const parseJson = <T>(text: string, context: string, schema: z.ZodType<T>): T => {
  try {
    return schema.parse(JSON.parse(text));
  } catch (cause) {
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    throw new Error(`Invalid ${context}${detail}`, { cause });
  }
};

const encodeJson = <T>(value: T, context: string, schema: z.ZodType<T>): string => {
  try {
    return JSON.stringify(schema.parse(value));
  } catch (cause) {
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    throw new Error(`Invalid ${context}${detail}`, { cause });
  }
};

export const encodePersistedDumpMetadata = (metadata: DumpMetadata, context: string): string => {
  const { upstream: _upstream, ...persisted } = metadata;
  return encodeJson(persisted, context, persistedDumpMetadataSchema);
};

export const decodePersistedDumpMetadata = (text: string, context: string): PersistedDumpMetadata =>
  parseJson(text, context, persistedDumpMetadataSchema);

export const encodeDumpHeaders = (headers: Array<[string, string]>, context: string): string =>
  encodeJson(headers, context, dumpHeadersSchema);

export const decodeDumpHeaders = (text: string, context: string): Array<[string, string]> =>
  parseJson(text, context, dumpHeadersSchema);

export const encodeDumpBodyDescriptor = (descriptor: DumpBodyDescriptor, context: string): string =>
  encodeJson(descriptor, context, dumpBodyDescriptorSchema);

export const decodeDumpBodyDescriptor = (text: string, context: string): DumpBodyDescriptor =>
  parseJson(text, context, dumpBodyDescriptorSchema);

export const encodeDumpStreamEvents = (events: DumpStreamEvent[], context: string): string =>
  encodeJson(events, context, dumpStreamEventsSchema);

export const decodeDumpStreamEvents = (text: string, context: string): DumpStreamEvent[] =>
  parseJson(text, context, dumpStreamEventsSchema);
