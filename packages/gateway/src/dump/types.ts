import type { z } from 'zod';

import type { dumpErrorSchema, dumpMetadataSchema, dumpUpstreamRefSchema } from './schemas.ts';

export type DumpRecordId = string;
export type DumpErrorMeta = z.infer<typeof dumpErrorSchema>;
export type DumpUpstreamRef = z.infer<typeof dumpUpstreamRefSchema>;
export type DumpMetadata = z.infer<typeof dumpMetadataSchema>;
