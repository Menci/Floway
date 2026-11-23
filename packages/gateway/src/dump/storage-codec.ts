import type { z } from 'zod';

import { persistedDumpMetadataSchema } from './schemas.ts';
import type { DumpMetadata } from './types.ts';

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
