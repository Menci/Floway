import type { z } from 'zod';

import type {
  dumpBrokerFrameSchema,
  dumpErrorSchema,
  dumpLiveSummarySchema,
  dumpMetadataSchema,
  dumpUpstreamRefSchema,
} from './schemas.ts';

export type DumpRecordId = string;

export type DumpUpstreamRef = z.infer<typeof dumpUpstreamRefSchema>;

export type DumpErrorMeta = z.infer<typeof dumpErrorSchema>;

export type DumpMetadata = z.infer<typeof dumpMetadataSchema>;

export type DumpLiveSummary = z.infer<typeof dumpLiveSummarySchema>;

export type DumpBrokerMessage = z.infer<typeof dumpBrokerFrameSchema>;

export type DumpRecordDetail = { readonly meta: DumpMetadata };

export const dumpLiveStreamId = (keyId: string, recordId: string): string =>
  `dump:${keyId}:${recordId}`;
