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

  it('switches sessions cleanly across export, restore, paste import, no-op paste, and clearHistory', () => {
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

    const session1 = useCopyEditorStore.getState().archiveActiveAsExport(payload.exportedAt);
    expect(session1).not.toBeNull();
    expect(Object.keys(useCopyEditorStore.getState().entries)).toHaveLength(0);
    expect(useCopyEditorStore.getState().history).toHaveLength(1);
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Abort');

    // Start a second active session, then restore session1: the active session swaps into history.
    useCopyEditorStore.getState().stageEntry({
      key: 'common.dismiss',
      route: '/dashboard',
      values: { en: 'Close now' },
      note: '',
    });
    useCopyEditorStore.getState().restoreHistorySession(session1!.id);
    expect(Object.keys(useCopyEditorStore.getState().entries)).toEqual(['common.cancel']);
    expect(useCopyEditorStore.getState().history).toHaveLength(1);
    expect(useCopyEditorStore.getState().history[0]!.entries.map(e => e.key)).toEqual(['common.dismiss']);
    // Both active and history remain silently applied in i18next.
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Abort');
    expect(i18n.t('common.dismiss', { lng: 'en' })).toBe('Close now');

    // Pasting the identical JSON is a no-op and does not duplicate history.
    const sameResult = useCopyEditorStore.getState().importFromJson(JSON.stringify(payload));
    expect(sameResult).toEqual({ imported: 1, skippedUpToDate: 0, changed: false });
    expect(useCopyEditorStore.getState().history).toHaveLength(1);

    // Pasting a different payload archives the active session and activates the pasted one.
    const otherPayload = {
      version: 1,
      exportedAt: '2026-11-19T12:00:00.000Z',
      entries: [
        {
          key: 'common.cancel',
          route: '/dashboard/settings',
          changes: { en: { before: 'Cancel', after: 'Stop' } },
        },
      ],
    };
    const nextResult = useCopyEditorStore.getState().importFromJson(JSON.stringify(otherPayload));
    expect(nextResult).toEqual({ imported: 1, skippedUpToDate: 0, changed: true });
    expect(useCopyEditorStore.getState().history).toHaveLength(2);
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Stop');

    // Deleting history reverts keys no longer overridden by active entries.
    useCopyEditorStore.getState().clearHistory();
    expect(useCopyEditorStore.getState().history).toHaveLength(0);
    expect(i18n.t('common.dismiss', { lng: 'en' })).toBe('Dismiss');
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Stop');
  });

  it('silently prunes persisted active and history edits that already shipped', async () => {
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
        history: [
          {
            id: 'session-1',
            archivedAt: '2026-11-19T00:00:00.000Z',
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
    expect(useCopyEditorStore.getState().history).toHaveLength(0);
  });
});
