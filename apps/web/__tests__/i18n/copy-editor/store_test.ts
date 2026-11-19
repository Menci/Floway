import { beforeEach, describe, expect, it } from 'vitest';

import { i18n, setLanguage } from '../../../src/i18n';
import { __testing, useCopyEditorStore } from '../../../src/i18n/copy-editor/store';
import { stubLocalStorage } from '../../local-storage-stub';

stubLocalStorage();

describe('copy editor store', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    __testing.reset();
    await setLanguage('en');
    await useCopyEditorStore.getState().ensureInitialized();
  });

  it('stages single-language edits, note-only entries, and syncs live i18n resources', async () => {
    const store = useCopyEditorStore.getState();
    const originalEn = store.getOriginal('en', 'common.cancel')!;
    const originalZh = store.getOriginal('zh-Hans', 'common.cancel')!;

    store.stageEntry({
      key: 'common.cancel',
      route: '/dashboard/settings',
      values: { 'zh-Hans': '放弃' },
      note: '',
    });

    expect(useCopyEditorStore.getState().entries['common.cancel']?.changes).toEqual({
      'zh-Hans': { before: originalZh, after: '放弃' },
    });
    expect(i18n.t('common.cancel', { lng: 'zh-Hans' })).toBe('放弃');
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe(originalEn);

    store.stageEntry({
      key: 'common.dismiss',
      route: '/dashboard',
      values: {},
      note: 'Use a friendlier word',
    });
    expect(useCopyEditorStore.getState().entries['common.dismiss']).toMatchObject({
      key: 'common.dismiss',
      changes: {},
      note: 'Use a friendlier word',
    });

    store.revertEntry('common.cancel');
    expect(useCopyEditorStore.getState().entries['common.cancel']).toBeUndefined();
    expect(i18n.t('common.cancel', { lng: 'zh-Hans' })).toBe(originalZh);
  });

  it('archives each export batch silently while keeping it active, and restores or deletes batches cleanly', () => {
    const store = useCopyEditorStore.getState();
    store.stageEntry({
      key: 'common.cancel',
      route: '/dashboard/settings',
      values: { en: 'Abort' },
      note: 'Match desktop terminology',
    });

    const payload = useCopyEditorStore.getState().buildExportPayload();
    expect(payload.version).toBe(1);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0]).toMatchObject({
      key: 'common.cancel',
      route: '/dashboard/settings',
      changes: { en: { before: 'Cancel', after: 'Abort' } },
      note: 'Match desktop terminology',
    });

    const batch = useCopyEditorStore.getState().archiveActiveAsExport(payload.exportedAt);
    expect(batch).not.toBeNull();
    // Active entries clear out of the main view, while the archived override stays silently applied.
    expect(Object.keys(useCopyEditorStore.getState().entries)).toHaveLength(0);
    expect(useCopyEditorStore.getState().exports).toHaveLength(1);
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Abort');
    expect(useCopyEditorStore.getState().getCurrent('en', 'common.cancel')).toBe('Abort');

    // Restoring merges the archived batch back into active edits and removes the archive record.
    useCopyEditorStore.getState().restoreExportBatch(batch!.id);
    expect(useCopyEditorStore.getState().exports).toHaveLength(0);
    expect(useCopyEditorStore.getState().entries['common.cancel']?.changes.en?.after).toBe('Abort');
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Abort');

    // Re-archive and delete restores the original copy in i18next.
    const batch2 = useCopyEditorStore.getState().archiveActiveAsExport();
    useCopyEditorStore.getState().deleteExportBatch(batch2!.id);
    expect(useCopyEditorStore.getState().exports).toHaveLength(0);
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Cancel');

    // clearExports wipes all archived batches and restores original copy.
    useCopyEditorStore.getState().stageEntry({
      key: 'common.cancel',
      route: '/dashboard/settings',
      values: { en: 'Abort' },
      note: '',
    });
    useCopyEditorStore.getState().archiveActiveAsExport();
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Abort');
    useCopyEditorStore.getState().clearExports();
    expect(useCopyEditorStore.getState().exports).toHaveLength(0);
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Cancel');

    // Importing the previously exported JSON restores and re-applies the preview.
    const imported = useCopyEditorStore.getState().importFromJson(JSON.stringify(payload));
    expect(imported).toEqual({ imported: 1, skippedUpToDate: 0 });
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Abort');
  });

  it('silently prunes persisted active and archived edits that already shipped', async () => {
    window.localStorage.setItem(
      __testing.storageKey,
      JSON.stringify({
        entries: {
          'common.cancel': {
            key: 'common.cancel',
            route: '/',
            changes: { en: { before: 'Old Cancel', after: 'Cancel' } },
            note: '',
            updatedAt: '2026-11-19T00:00:00.000Z',
          },
        },
        exports: [
          {
            id: 'batch-1',
            exportedAt: '2026-11-19T00:00:00.000Z',
            entries: [
              {
                key: 'common.cancel',
                route: '/',
                changes: { en: { before: 'Old Cancel', after: 'Cancel' } },
                note: '',
                updatedAt: '2026-11-19T00:00:00.000Z',
              },
            ],
          },
        ],
      }),
    );

    __testing.reset();
    await useCopyEditorStore.getState().ensureInitialized();
    expect(useCopyEditorStore.getState().entries['common.cancel']).toBeUndefined();
    expect(useCopyEditorStore.getState().exports).toHaveLength(0);
  });
});
