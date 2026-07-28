import type { InferResponseType } from 'hono/client';
import { z } from 'zod';

import type { api } from '../../api/client';

// Annotated with the gateway's own literal so a bump there fails this
// assignment rather than silently leaving the dashboard rejecting every backup
// file the current deployment writes.
export const BACKUP_FILE_VERSION: InferResponseType<typeof api.api.export.$get, 200>['version'] = 18;

const backupFileSchema = z.object({
  version: z.literal(BACKUP_FILE_VERSION),
  exportedAt: z.string(),
  data: z.object({
    users: z.array(z.unknown()),
    apiKeys: z.array(z.unknown()),
    upstreams: z.array(z.unknown()),
    proxies: z.array(z.unknown()),
    usage: z.array(z.unknown()),
    searchUsage: z.array(z.unknown()),
    performance: z.array(z.unknown()).optional(),
    performanceIncluded: z.boolean(),
    searchConfig: z.unknown(),
  }).strict().superRefine((data, ctx) => {
    if (data.performanceIncluded !== (data.performance !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'performance must be present exactly when performanceIncluded is true',
        path: ['performance'],
      });
    }
  }),
}).strict();

export type BackupFile = z.infer<typeof backupFileSchema>;
export type BackupFileData = BackupFile['data'];

export const parseBackupFile = (
  raw: string,
): { ok: true; payload: BackupFile } | { ok: false } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const result = backupFileSchema.safeParse(parsed);
  return result.success ? { ok: true, payload: result.data } : { ok: false };
};
