import { beforeEach, describe, expect, it } from 'vitest';

import { i18n, setLanguage } from '../../../src/i18n';
import { __testing, MAX_HISTORY_SESSIONS, useCopyEditorStore } from '../../../src/i18n/copy-editor/store';
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

  it('exports without route, switches sessions cleanly, ignores exportedAt on import, and no-ops identical paste', () => {
    const store = useCopyEditorStore.getState();
    store.stageEntry({
      key: 'common.cancel',
      values: { en: 'Abort' },
      note: 'Match desktop terminology',
    });

    const payload = useCopyEditorStore.getState().buildExportPayload();
    expect(payload.version).toBe(1);
    expect(payload.exportedAt).toBeTruthy();
    expect(payload.entries).toEqual([
      {
        key: 'common.cancel',
        changes: { en: { before: 'Cancel', after: 'Abort' } },
        note: 'Match desktop terminology',
      },
    ]);

    const session1 = useCopyEditorStore.getState().archiveActiveAsExport(payload.exportedAt);
    expect(session1).not.toBeNull();
    expect(Object.keys(useCopyEditorStore.getState().entries)).toHaveLength(0);
    expect(useCopyEditorStore.getState().history).toHaveLength(1);
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Abort');

    // Start a second active session, then restore session1: the active session swaps into history.
    useCopyEditorStore.getState().stageEntry({
      key: 'common.dismiss',
      values: { en: 'Close now' },
      note: '',
    });
    useCopyEditorStore.getState().restoreHistorySession(session1!.id);
    expect(Object.keys(useCopyEditorStore.getState().entries)).toEqual(['common.cancel']);
    expect(useCopyEditorStore.getState().history).toHaveLength(1);
    expect(useCopyEditorStore.getState().history[0]!.entries.map(e => e.key)).toEqual(['common.dismiss']);
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Abort');
    expect(i18n.t('common.dismiss', { lng: 'en' })).toBe('Close now');

    // Pasting the identical JSON (even with a different exportedAt) is a no-op.
    const sameResult = useCopyEditorStore.getState().importFromJson(
      JSON.stringify({ ...payload, exportedAt: '2020-01-01T00:00:00.000Z' }),
    );
    expect(sameResult).toEqual({ imported: 1, changed: false });
    expect(useCopyEditorStore.getState().history).toHaveLength(1);

    // Pasting a different payload archives the active session and activates the pasted one.
    const otherPayload = {
      version: 1,
      exportedAt: '2026-11-19T12:00:00.000Z',
      entries: [
        {
          key: 'common.cancel',
          changes: { en: { before: 'Old Cancel', after: 'Cancel' } },
        },
      ],
    };
    const nextResult = useCopyEditorStore.getState().importFromJson(JSON.stringify(otherPayload));
    expect(nextResult).toEqual({ imported: 1, changed: true });
    expect(useCopyEditorStore.getState().history).toHaveLength(2);
    // Already-applied entry is kept so the UI can show the green checkmark state.
    expect(useCopyEditorStore.getState().entries['common.cancel']?.changes.en).toEqual({
      before: 'Old Cancel',
      after: 'Cancel',
    });

    // Importing a key absent from the current build preserves it for UI display without polluting i18next.
    const missingResult = useCopyEditorStore.getState().importFromJson(JSON.stringify({
      version: 1,
      entries: [{ key: 'nonexistent.removed.key', changes: { en: { before: 'Old', after: 'New' } } }],
    }));
    expect(missingResult).toEqual({ imported: 1, changed: true });
    expect(useCopyEditorStore.getState().entries['nonexistent.removed.key']).toBeDefined();
    expect(useCopyEditorStore.getState().getOriginal('en', 'nonexistent.removed.key')).toBeUndefined();
    expect(i18n.exists('nonexistent.removed.key', { lng: 'en' })).toBe(false);

    // Stale edits whose before does not match the current build do not override live i18next copy.
    useCopyEditorStore.getState().importFromJson(JSON.stringify({
      version: 1,
      entries: [{ key: 'common.cancel', changes: { en: { before: 'Outdated Cancel', after: 'Should Not Apply' } } }],
    }));
    expect(useCopyEditorStore.getState().entries['common.cancel']?.changes.en?.after).toBe('Should Not Apply');
    // Falls back to the latest matching history entry ('Abort') rather than applying the stale edit.
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Abort');

    // Deleting history reverts keys no longer overridden by valid active entries.
    useCopyEditorStore.getState().clearHistory();
    expect(useCopyEditorStore.getState().history).toHaveLength(0);
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Cancel');
    expect(i18n.t('common.dismiss', { lng: 'en' })).toBe('Dismiss');
  });

  it('caps history at MAX_HISTORY_SESSIONS and reverts evicted oldest overrides', () => {
    const store = useCopyEditorStore.getState();
    store.stageEntry({
      key: 'common.cancel',
      values: { en: 'Oldest override' },
      note: '',
    });
    store.archiveActiveAsExport('2026-01-01T00:00:00.000Z');
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Oldest override');

    for (let i = 0; i < MAX_HISTORY_SESSIONS; i += 1) {
      store.stageEntry({
        key: 'common.dismiss',
        values: { en: `Dismiss ${i}` },
        note: '',
      });
      store.archiveActiveAsExport(`2026-01-02T00:00:${String(i % 60).padStart(2, '0')}.000Z`);
    }

    expect(useCopyEditorStore.getState().history).toHaveLength(MAX_HISTORY_SESSIONS);
    // The first session (common.cancel) was evicted and reverted back to original copy.
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Cancel');
    expect(i18n.t('common.dismiss', { lng: 'en' })).toBe(`Dismiss ${MAX_HISTORY_SESSIONS - 1}`);
  });
});
