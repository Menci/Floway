import { beforeEach, describe, expect, it } from 'vitest';

import { i18n, setLanguage } from '../../../src/i18n';
import { __testing, useUiTextEditorStore } from '../../../src/i18n/ui-text-editor/store';
import { stubLocalStorage } from '../../local-storage-stub';

stubLocalStorage();

describe('UI text editor store', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    __testing.reset();
    await setLanguage('en');
    await useUiTextEditorStore.getState().ensureInitialized();
  });

  it('saves single-language edits, note-only entries, and syncs live i18n resources', async () => {
    const store = useUiTextEditorStore.getState();
    const originalEn = store.getOriginal('en', 'common.cancel')!;
    const originalZh = store.getOriginal('zh-Hans', 'common.cancel')!;

    store.saveEntry({
      key: 'common.cancel',
      values: { 'zh-Hans': '放弃' },
      note: '',
    });

    expect(useUiTextEditorStore.getState().entries['common.cancel']?.changes).toEqual({
      'zh-Hans': { before: originalZh, after: '放弃' },
    });
    expect(i18n.t('common.cancel', { lng: 'zh-Hans' })).toBe('放弃');
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe(originalEn);

    store.saveEntry({
      key: 'common.dismiss',
      values: {},
      note: 'Use a friendlier word',
    });
    expect(useUiTextEditorStore.getState().entries['common.dismiss']).toMatchObject({
      key: 'common.dismiss',
      changes: {},
      note: 'Use a friendlier word',
    });

    store.revertEntry('common.cancel');
    expect(useUiTextEditorStore.getState().entries['common.cancel']).toBeUndefined();
    expect(i18n.t('common.cancel', { lng: 'zh-Hans' })).toBe(originalZh);
  });

  it('exports without route, switches sessions cleanly, ignores exportedAt on import, and no-ops identical paste', () => {
    const store = useUiTextEditorStore.getState();
    store.saveEntry({
      key: 'common.cancel',
      values: { en: 'Abort' },
      note: 'Match desktop terminology',
    });

    const snapshot = useUiTextEditorStore.getState().createExportSnapshot();
    expect(snapshot).not.toBeNull();
    const payload = snapshot!.payload;
    expect(payload.version).toBe(1);
    expect(payload.exportedAt).toBeTruthy();
    expect(payload.entries).toEqual([
      {
        key: 'common.cancel',
        changes: { en: { before: 'Cancel', after: 'Abort' } },
        note: 'Match desktop terminology',
      },
    ]);

    const session1 = useUiTextEditorStore.getState().commitExportSnapshot(snapshot!);
    expect(session1).not.toBeNull();
    expect(Object.keys(useUiTextEditorStore.getState().entries)).toHaveLength(0);
    expect(useUiTextEditorStore.getState().history).toHaveLength(1);
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Abort');

    useUiTextEditorStore.getState().saveEntry({
      key: 'common.dismiss',
      values: { en: 'Close now' },
      note: '',
    });
    useUiTextEditorStore.getState().restoreHistorySession(session1!.id);
    expect(Object.keys(useUiTextEditorStore.getState().entries)).toEqual(['common.cancel']);
    expect(useUiTextEditorStore.getState().history).toHaveLength(1);
    expect(useUiTextEditorStore.getState().history[0]!.entries.map(e => e.key)).toEqual(['common.dismiss']);
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Abort');
    expect(i18n.t('common.dismiss', { lng: 'en' })).toBe('Close now');

    const sameResult = useUiTextEditorStore.getState().importFromJson(
      JSON.stringify({ ...payload, exportedAt: '2020-01-01T00:00:00.000Z' }),
    );
    expect(sameResult).toEqual({ imported: 1, changed: false });
    expect(useUiTextEditorStore.getState().history).toHaveLength(1);

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
    const nextResult = useUiTextEditorStore.getState().importFromJson(JSON.stringify(otherPayload));
    expect(nextResult).toEqual({ imported: 1, changed: true });
    expect(useUiTextEditorStore.getState().history).toHaveLength(2);
    // Already-applied entry is kept so the UI can show the green checkmark state.
    expect(useUiTextEditorStore.getState().entries['common.cancel']?.changes.en).toEqual({
      before: 'Old Cancel',
      after: 'Cancel',
    });

    // Importing a key absent from the current build preserves it for UI display without polluting i18next.
    const missingResult = useUiTextEditorStore.getState().importFromJson(JSON.stringify({
      version: 1,
      entries: [{ key: 'nonexistent.removed.key', changes: { en: { before: 'Old', after: 'New' } } }],
    }));
    expect(missingResult).toEqual({ imported: 1, changed: true });
    expect(useUiTextEditorStore.getState().entries['nonexistent.removed.key']).toBeDefined();
    expect(useUiTextEditorStore.getState().getOriginal('en', 'nonexistent.removed.key')).toBeUndefined();
    expect(i18n.exists('nonexistent.removed.key', { lng: 'en' })).toBe(false);

    useUiTextEditorStore.getState().importFromJson(JSON.stringify({
      version: 1,
      entries: [{ key: 'common.cancel', changes: { en: { before: 'Outdated Cancel', after: 'Should Not Apply' } } }],
    }));
    expect(useUiTextEditorStore.getState().entries['common.cancel']?.changes.en?.after).toBe('Should Not Apply');
    // The live projection uses the latest matching history entry ('Abort'); the stale active entry remains available for display.
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Abort');

    // Deleting history reverts keys no longer overridden by valid active entries.
    useUiTextEditorStore.getState().clearHistory();
    expect(useUiTextEditorStore.getState().history).toHaveLength(0);
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Cancel');
    expect(i18n.t('common.dismiss', { lng: 'en' })).toBe('Dismiss');
  });

  it('caps history at 200 sessions and reverts evicted oldest overrides', () => {
    const cap = 200;
    const store = useUiTextEditorStore.getState();
    store.saveEntry({
      key: 'common.cancel',
      values: { en: 'Oldest override' },
      note: '',
    });
    store.commitExportSnapshot(useUiTextEditorStore.getState().createExportSnapshot()!);
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Oldest override');

    for (let i = 0; i < cap; i += 1) {
      store.saveEntry({
        key: 'common.dismiss',
        values: { en: `Dismiss ${i}` },
        note: '',
      });
      store.commitExportSnapshot(useUiTextEditorStore.getState().createExportSnapshot()!);
    }

    expect(useUiTextEditorStore.getState().history).toHaveLength(cap);
    expect(i18n.t('common.cancel', { lng: 'en' })).toBe('Cancel');
    expect(i18n.t('common.dismiss', { lng: 'en' })).toBe(`Dismiss ${cap - 1}`);
  });
  it('refuses writes before initialization so existing localStorage history is never overwritten', async () => {
    const seeded = {
      entries: {
        'common.cancel': {
          key: 'common.cancel',
          changes: { en: { before: 'Cancel', after: 'Keep me' } },
          note: '',
          updatedAt: '2026-11-19T00:00:00.000Z',
        },
      },
      history: [],
    };
    window.localStorage.setItem(__testing.storageKey, JSON.stringify(seeded));
    __testing.reset();

    expect(useUiTextEditorStore.getState().saveEntry({
      key: 'common.dismiss',
      values: { en: 'Should not persist' },
      note: '',
    })).toBe(false);

    await useUiTextEditorStore.getState().ensureInitialized();
    expect(Object.keys(useUiTextEditorStore.getState().entries)).toEqual(['common.cancel']);
    expect(useUiTextEditorStore.getState().entries['common.cancel']?.changes.en?.after).toBe('Keep me');
  });

  it('archives only the captured export snapshot and preserves concurrent edits made before commit', () => {
    const store = useUiTextEditorStore.getState();
    store.saveEntry({ key: 'common.cancel', values: { en: 'Abort' }, note: '' });

    const snapshot = useUiTextEditorStore.getState().createExportSnapshot();
    expect(snapshot).not.toBeNull();

    useUiTextEditorStore.getState().saveEntry({ key: 'common.dismiss', values: { en: 'Hide' }, note: '' });

    const session = useUiTextEditorStore.getState().commitExportSnapshot(snapshot!);
    expect(session?.entries.map(e => e.key)).toEqual(['common.cancel']);
    expect(Object.keys(useUiTextEditorStore.getState().entries)).toEqual(['common.dismiss']);
  });

  it('saves edits that drop a numeric format without crashing live i18next rendering', () => {
    const store = useUiTextEditorStore.getState();
    store.saveEntry({
      key: 'common.uiTextEditor.editsCount_other',
      values: { en: '{{count}} edits' },
      note: '',
    });

    // Stored and exported intact, yet skipped from live i18next projection so formatting never throws.
    expect(useUiTextEditorStore.getState().entries['common.uiTextEditor.editsCount_other']?.changes.en?.after).toBe('{{count}} edits');
    expect(i18n.t('common.uiTextEditor.editsCount', { count: 3, lng: 'en' })).toBe('3 edits');
  });

  it('rejects unsupported export versions and ignores changes without an explicit before value', () => {
    expect(() => useUiTextEditorStore.getState().importFromJson(JSON.stringify({ version: 99, entries: [] })))
      .toThrow(TypeError);

    const result = useUiTextEditorStore.getState().importFromJson(JSON.stringify({
      version: 1,
      entries: [{ key: 'common.cancel', changes: { en: { after: 'No before' } } }],
    }));
    expect(result).toEqual({ imported: 0, changed: false });
  });
});
