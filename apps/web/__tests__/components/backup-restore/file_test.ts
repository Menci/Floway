import { describe, expect, it } from 'vitest';

import { BACKUP_FILE_VERSION, parseBackupFile } from '../../../src/components/backup-restore/file';

const data = {
  users: [],
  userPreferences: [],
  groups: [],
  accessRecords: [],
  apiKeys: [],
  upstreams: [],
  proxies: [],
  usage: [],
  searchUsage: [],
  upstreamMetrics: [],
  performanceIncluded: false,
  searchConfig: null,
  siteSettings: { siteName: null },
};

const backup = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  version: BACKUP_FILE_VERSION,
  exportedAt: '2026-07-28T00:00:00.000Z',
  data,
  ...overrides,
});

describe('backup file validation', () => {
  it('rejects unknown fields instead of stripping them', () => {
    expect(parseBackupFile(backup({ typo: true })).ok).toBe(false);
    expect(parseBackupFile(backup({ data: { ...data, typo: [] } })).ok).toBe(false);
  });

  it('keeps performance presence synchronized with its flag', () => {
    expect(parseBackupFile(backup({ data: { ...data, performance: [] } })).ok).toBe(false);
    expect(parseBackupFile(backup({ data: { ...data, performanceIncluded: true } })).ok).toBe(false);
    expect(parseBackupFile(backup({ data: { ...data, performanceIncluded: true, performance: [] } })).ok).toBe(true);
  });
});
