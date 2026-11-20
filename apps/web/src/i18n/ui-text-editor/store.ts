import { create } from 'zustand';

import { ensureLocaleLoaded, i18n } from '../index';
import { supportedLanguages, type SupportedLanguage } from '../languages';
import { numberFormats } from '../number-format';
import { loadLocale } from '../resources';

const STORAGE_KEY = 'floway.uiTextEditorState.v1';
export const MAX_HISTORY_SESSIONS = 200;

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  'en': 'English',
  'zh-Hans': '简体中文',
};

export const SHORT_LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  'en': 'EN',
  'zh-Hans': '中文',
};

export interface LanguageChange {
  before: string;
  after: string;
}

export interface UiTextEditEntry {
  key: string;
  changes: Partial<Record<SupportedLanguage, LanguageChange>>;
  note: string;
  updatedAt: string;
}

export interface UiTextHistorySession {
  id: string;
  archivedAt: string;
  entries: UiTextEditEntry[];
}

export interface ExportedUiTextChange {
  key: string;
  changes?: Partial<Record<SupportedLanguage, LanguageChange>>;
  note?: string;
}

export interface UiTextEditorExportPayload {
  version: 1;
  exportedAt: string;
  entries: ExportedUiTextChange[];
}

export interface ExportSnapshot {
  payload: UiTextEditorExportPayload;
  entries: Record<string, UiTextEditEntry>;
}

export interface SaveEntryInput {
  key: string;
  values: Partial<Record<SupportedLanguage, string>>;
  note: string;
}

export interface ImportResult {
  imported: number;
  changed: boolean;
}

interface PersistedState {
  entries: Record<string, UiTextEditEntry>;
  history: UiTextHistorySession[];
}

const flattenLeaves = (value: object, prefix = ''): Map<string, string> => {
  const map = new Map<string, string>();
  const walk = (node: object, pathPrefix: string): void => {
    for (const [k, child] of Object.entries(node)) {
      const path = pathPrefix ? `${pathPrefix}.${k}` : k;
      if (typeof child === 'object' && child !== null) {
        walk(child, path);
      } else {
        map.set(path, String(child));
      }
    }
  };
  walk(value, prefix);
  return map;
};

const isSupportedLanguage = (value: string): value is SupportedLanguage =>
  (supportedLanguages as readonly string[]).includes(value);

const INTERPOLATION_RE = /\{\{\s*([^},\s]+)(?:\s*,\s*([^}\s]+))?\s*\}\}/g;

const parseInterpolations = (text: string): Map<string, string | undefined> => {
  const map = new Map<string, string | undefined>();
  INTERPOLATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INTERPOLATION_RE.exec(text)) !== null) {
    map.set(match[1]!, match[2]);
  }
  return map;
};

// `number-format.ts` throws at render when a numeric interpolation omits its
// format or names an unknown format. Users are free to save and export any
// template text, so we keep edits intact in the store while skipping live
// i18next injection if the edited string would crash the formatter at render.
const isSafeForLiveProjection = (original: string, candidate: string): boolean => {
  const originalSpecs = parseInterpolations(original);
  const candidateSpecs = parseInterpolations(candidate);
  for (const [name, format] of candidateSpecs) {
    if (format !== undefined && !Object.hasOwn(numberFormats, format)) {
      return false;
    }
    const originalFormat = originalSpecs.get(name);
    if (originalFormat !== undefined && format === undefined) {
      return false;
    }
  }
  return true;
};

const parseEntry = (raw: unknown, fallbackKey?: string): UiTextEditEntry | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const key = typeof rec.key === 'string' && rec.key.trim().length > 0 ? rec.key.trim() : fallbackKey;
  if (!key) return null;

  const changes: Partial<Record<SupportedLanguage, LanguageChange>> = {};
  if (rec.changes && typeof rec.changes === 'object' && !Array.isArray(rec.changes)) {
    for (const [lang, change] of Object.entries(rec.changes as Record<string, unknown>)) {
      if (!isSupportedLanguage(lang) || !change || typeof change !== 'object' || Array.isArray(change)) continue;
      const ch = change as Record<string, unknown>;
      if (typeof ch.before === 'string' && typeof ch.after === 'string') {
        changes[lang] = { before: ch.before, after: ch.after };
      }
    }
  }
  const note = typeof rec.note === 'string' ? rec.note : '';
  if (Object.keys(changes).length === 0 && note.trim().length === 0) return null;

  const updatedAt = typeof rec.updatedAt === 'string' ? rec.updatedAt : new Date().toISOString();
  return { key, changes, note, updatedAt };
};

const readStoredState = (): PersistedState => {
  if (typeof window === 'undefined') return { entries: {}, history: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { entries: {}, history: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { entries: {}, history: [] };
    }
    const rec = parsed as Record<string, unknown>;

    const entries: Record<string, UiTextEditEntry> = {};
    if (rec.entries && typeof rec.entries === 'object' && !Array.isArray(rec.entries)) {
      for (const [k, rawEntry] of Object.entries(rec.entries as Record<string, unknown>)) {
        const entry = parseEntry(rawEntry, k);
        if (entry) entries[entry.key] = entry;
      }
    }

    const history: UiTextHistorySession[] = [];
    if (Array.isArray(rec.history)) {
      for (const rawSession of rec.history) {
        if (!rawSession || typeof rawSession !== 'object' || Array.isArray(rawSession)) continue;
        const sessionRec = rawSession as Record<string, unknown>;
        const id = typeof sessionRec.id === 'string' && sessionRec.id.length > 0 ? sessionRec.id : null;
        const archivedAt = typeof sessionRec.archivedAt === 'string' ? sessionRec.archivedAt : null;
        if (!id || !archivedAt || !Array.isArray(sessionRec.entries)) continue;
        const sessionEntries = sessionRec.entries
          .map(item => parseEntry(item))
          .filter((item): item is UiTextEditEntry => item !== null);
        if (sessionEntries.length > 0) {
          history.push({ id, archivedAt, entries: sessionEntries });
        }
      }
    }

    return { entries, history: history.slice(0, MAX_HISTORY_SESSIONS) };
  } catch {
    return { entries: {}, history: [] };
  }
};

const writeStoredState = (state: PersistedState): boolean => {
  if (typeof window === 'undefined') return true;
  try {
    if (Object.keys(state.entries).length === 0 && state.history.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    return true;
  } catch {
    return false;
  }
};

type OriginalsMap = Record<SupportedLanguage, Map<string, string>>;

const emptyOriginals = (): OriginalsMap => ({
  'en': new Map(),
  'zh-Hans': new Map(),
});

const applyResourceValue = (language: SupportedLanguage, key: string, value: string): void => {
  i18n.addResource(language, 'translation', key, value);
};

// Resolves the live override for `(language, key)` across history sessions
// (newest first) and active edits (highest precedence). An edit takes effect
// only when its recorded `before` matches the running build's original string
// and its `after` passes live formatter safety.
const resolveEffectiveValue = (
  language: SupportedLanguage,
  key: string,
  originals: OriginalsMap,
  entries: Record<string, UiTextEditEntry>,
  history: UiTextHistorySession[],
): string | undefined => {
  const original = originals[language].get(key);
  if (original === undefined) return undefined;

  const active = entries[key]?.changes[language];
  if (active?.before === original && isSafeForLiveProjection(original, active.after)) {
    return active.after;
  }

  for (const session of history) {
    const match = session.entries.find(item => item.key === key);
    const change = match?.changes[language];
    if (change?.before === original && isSafeForLiveProjection(original, change.after)) {
      return change.after;
    }
  }

  return original;
};

const capHistory = (
  sessions: UiTextHistorySession[],
): { kept: UiTextHistorySession[]; evictedKeys: string[] } => {
  if (sessions.length <= MAX_HISTORY_SESSIONS) {
    return { kept: sessions, evictedKeys: [] };
  }
  const kept = sessions.slice(0, MAX_HISTORY_SESSIONS);
  const evictedKeys: string[] = [];
  for (const session of sessions.slice(MAX_HISTORY_SESSIONS)) {
    for (const entry of session.entries) evictedKeys.push(entry.key);
  }
  return { kept, evictedKeys };
};

const syncKeysToI18n = (
  keys: Iterable<string>,
  originals: OriginalsMap,
  entries: Record<string, UiTextEditEntry>,
  history: UiTextHistorySession[],
): void => {
  for (const key of keys) {
    for (const language of supportedLanguages) {
      if (!originals[language].has(key)) continue;
      const value = resolveEffectiveValue(language, key, originals, entries, history);
      if (value !== undefined) {
        applyResourceValue(language, key, value);
      }
    }
  }
};

const formatExportEntries = (list: UiTextEditEntry[]): ExportedUiTextChange[] =>
  [...list]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(entry => {
      const item: ExportedUiTextChange = {
        key: entry.key,
      };
      if (Object.keys(entry.changes).length > 0) {
        item.changes = entry.changes;
      }
      const trimmedNote = entry.note.trim();
      if (trimmedNote.length > 0) {
        item.note = trimmedNote;
      }
      return item;
    });

const makeSessionId = (archivedAt: string): string =>
  `${archivedAt}-${Math.random().toString(36).slice(2, 8)}`;

const areEntriesEqual = (a: UiTextEditEntry | undefined, b: UiTextEditEntry | undefined): boolean => {
  if (!a || !b) return a === b;
  if (a.note.trim() !== b.note.trim()) return false;
  for (const lang of supportedLanguages) {
    const ca = a.changes[lang];
    const cb = b.changes[lang];
    if ((ca === undefined) !== (cb === undefined)) return false;
    if (ca && cb && (ca.before !== cb.before || ca.after !== cb.after)) return false;
  }
  return true;
};

const areEntrySetsEqual = (
  a: Record<string, UiTextEditEntry>,
  b: Record<string, UiTextEditEntry>,
): boolean => {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(key => areEntriesEqual(a[key], b[key]));
};

const cloneEntriesMap = (entries: Record<string, UiTextEditEntry>): Record<string, UiTextEditEntry> => {
  const out: Record<string, UiTextEditEntry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const changes: Partial<Record<SupportedLanguage, LanguageChange>> = {};
    for (const lang of supportedLanguages) {
      const ch = entry.changes[lang];
      if (ch) changes[lang] = { before: ch.before, after: ch.after };
    }
    out[key] = { ...entry, changes };
  }
  return out;
};

const buildHistorySession = (
  entries: Record<string, UiTextEditEntry>,
  archivedAt: string,
): UiTextHistorySession | null => {
  const list = Object.values(entries).sort((a, b) => a.key.localeCompare(b.key));
  if (list.length === 0) return null;
  return {
    id: makeSessionId(archivedAt),
    archivedAt,
    entries: list,
  };
};

export interface UiTextEditorStore {
  initialized: boolean;
  originals: OriginalsMap;
  entries: Record<string, UiTextEditEntry>;
  history: UiTextHistorySession[];
  ensureInitialized: () => Promise<void>;
  getOriginal: (language: SupportedLanguage, key: string) => string | undefined;
  getCurrent: (language: SupportedLanguage, key: string) => string | undefined;
  saveEntry: (input: SaveEntryInput) => boolean;
  revertEntry: (key: string) => void;
  revertLanguage: (key: string, language: SupportedLanguage) => void;
  clearActive: () => void;
  createExportSnapshot: () => ExportSnapshot | null;
  buildExportPayload: () => UiTextEditorExportPayload;
  buildHistoryExportPayload: (sessionId: string) => UiTextEditorExportPayload | null;
  commitExportSnapshot: (snapshot: ExportSnapshot) => UiTextHistorySession | null;
  archiveActiveAsExport: (archivedAt?: string) => UiTextHistorySession | null;
  restoreHistorySession: (sessionId: string) => void;
  deleteHistorySession: (sessionId: string) => void;
  clearHistory: () => void;
  importFromJson: (rawJson: string) => ImportResult;
}

let initPromise: Promise<void> | null = null;

export const useUiTextEditorStore = create<UiTextEditorStore>((set, get) => {
  const commit = (
    nextEntries: Record<string, UiTextEditEntry>,
    nextHistory: UiTextHistorySession[],
    touchedKeys: Iterable<string>,
  ): boolean => {
    const persisted = writeStoredState({ entries: nextEntries, history: nextHistory });
    syncKeysToI18n(touchedKeys, get().originals, nextEntries, nextHistory);
    set({ entries: nextEntries, history: nextHistory });
    return persisted;
  };

  return {
    initialized: false,
    originals: emptyOriginals(),
    entries: {},
    history: [],

    ensureInitialized: async () => {
      if (get().initialized) return;
      if (initPromise) return await initPromise;

      initPromise = (async () => {
        const loaded = await Promise.all(
          supportedLanguages.map(async language => {
            const resource = await loadLocale(language);
            const translation = (resource.translation ?? {}) as object;
            // Ensure every supported language's full bundle is loaded in i18next
            // (not just shellResources for defaultLanguage) so edits to any
            // language can be applied and previewed immediately.
            await ensureLocaleLoaded(language);
            return [language, flattenLeaves(translation)] as const;
          }),
        );

        const originals = emptyOriginals();
        for (const [language, leaves] of loaded) {
          originals[language] = leaves;
        }

        const state = readStoredState();
        const touchedKeys = new Set<string>();
        for (const session of state.history) {
          for (const entry of session.entries) touchedKeys.add(entry.key);
        }
        for (const key of Object.keys(state.entries)) touchedKeys.add(key);
        syncKeysToI18n(touchedKeys, originals, state.entries, state.history);

        set({
          initialized: true,
          originals,
          entries: state.entries,
          history: state.history,
        });
      })();

      try {
        await initPromise;
      } finally {
        initPromise = null;
      }
    },

    getOriginal: (language, key) => get().originals[language].get(key),

    getCurrent: (language, key) => {
      const { originals, entries, history } = get();
      return resolveEffectiveValue(language, key, originals, entries, history);
    },

    saveEntry: ({ key, values, note }) => {
      const { initialized, originals, entries, history } = get();
      if (!initialized) return false;

      const prev = entries[key];
      const nextChanges: Partial<Record<SupportedLanguage, LanguageChange>> = {};

      for (const language of supportedLanguages) {
        const original = originals[language].get(key);
        if (original === undefined) continue;
        const nextValue = values[language];
        if (nextValue === undefined) {
          if (prev?.changes[language]) nextChanges[language] = prev.changes[language];
          continue;
        }
        if (nextValue !== original) {
          nextChanges[language] = { before: original, after: nextValue };
        } else if (prev?.changes[language]?.after === original) {
          // Keep an already-landed entry intact when editing another field on the same key.
          nextChanges[language] = prev.changes[language]!;
        }
      }

      const trimmedNote = note.trim();
      const nextEntries = { ...entries };
      if (Object.keys(nextChanges).length === 0 && trimmedNote.length === 0) {
        delete nextEntries[key];
      } else {
        nextEntries[key] = {
          key,
          changes: nextChanges,
          note,
          updatedAt: new Date().toISOString(),
        };
      }

      return commit(nextEntries, history, [key]);
    },

    revertLanguage: (key, language) => {
      const { initialized, entries, history } = get();
      if (!initialized) return;
      const prev = entries[key];
      if (!prev) return;

      const nextChanges = { ...prev.changes };
      delete nextChanges[language];

      const nextEntries = { ...entries };
      if (Object.keys(nextChanges).length === 0 && prev.note.trim().length === 0) {
        delete nextEntries[key];
      } else {
        nextEntries[key] = {
          ...prev,
          changes: nextChanges,
          updatedAt: new Date().toISOString(),
        };
      }

      commit(nextEntries, history, [key]);
    },

    revertEntry: key => {
      const { initialized, entries, history } = get();
      if (!initialized || !entries[key]) return;
      const nextEntries = { ...entries };
      delete nextEntries[key];
      commit(nextEntries, history, [key]);
    },

    clearActive: () => {
      const { initialized, entries, history } = get();
      if (!initialized) return;
      const touched = Object.keys(entries);
      if (touched.length === 0) return;
      commit({}, history, touched);
    },

    createExportSnapshot: () => {
      const { entries } = get();
      const snapshotEntries = cloneEntriesMap(entries);
      const list = Object.values(snapshotEntries);
      if (list.length === 0) return null;
      return {
        payload: {
          version: 1,
          exportedAt: new Date().toISOString(),
          entries: formatExportEntries(list),
        },
        entries: snapshotEntries,
      };
    },

    buildExportPayload: () => ({
      version: 1,
      exportedAt: new Date().toISOString(),
      entries: formatExportEntries(Object.values(get().entries)),
    }),

    buildHistoryExportPayload: sessionId => {
      const session = get().history.find(item => item.id === sessionId);
      if (!session) return null;
      return {
        version: 1,
        exportedAt: session.archivedAt,
        entries: formatExportEntries(session.entries),
      };
    },

    commitExportSnapshot: snapshot => {
      const { initialized, entries, history } = get();
      if (!initialized) return null;
      const session = buildHistorySession(snapshot.entries, snapshot.payload.exportedAt);
      if (!session) return null;

      // Only clear entries that have not been modified since the snapshot was taken.
      const nextEntries = { ...entries };
      const touchedKeys = new Set<string>();
      for (const [key, snapEntry] of Object.entries(snapshot.entries)) {
        if (areEntriesEqual(nextEntries[key], snapEntry)) {
          delete nextEntries[key];
          touchedKeys.add(key);
        }
      }

      const { kept: nextHistory, evictedKeys } = capHistory([session, ...history]);
      for (const key of evictedKeys) touchedKeys.add(key);
      commit(nextEntries, nextHistory, touchedKeys);
      return session;
    },

    archiveActiveAsExport: (archivedAt = new Date().toISOString()) => {
      const { initialized, entries } = get();
      if (!initialized) return null;
      const snapshotEntries = cloneEntriesMap(entries);
      const list = Object.values(snapshotEntries);
      if (list.length === 0) return null;
      return get().commitExportSnapshot({
        payload: {
          version: 1,
          exportedAt: archivedAt,
          entries: formatExportEntries(list),
        },
        entries: snapshotEntries,
      });
    },

    restoreHistorySession: sessionId => {
      const { initialized, entries, history } = get();
      if (!initialized) return;
      const target = history.find(item => item.id === sessionId);
      if (!target) return;

      const now = new Date().toISOString();
      const archivedCurrent = buildHistorySession(entries, now);
      const remaining = history.filter(item => item.id !== sessionId);
      const { kept: nextHistory, evictedKeys } = capHistory(
        archivedCurrent ? [archivedCurrent, ...remaining] : remaining,
      );

      const nextEntries: Record<string, UiTextEditEntry> = {};
      const touchedKeys = new Set<string>([...Object.keys(entries), ...evictedKeys]);
      for (const item of target.entries) {
        nextEntries[item.key] = { ...item };
        touchedKeys.add(item.key);
      }

      commit(nextEntries, nextHistory, touchedKeys);
    },

    deleteHistorySession: sessionId => {
      const { initialized, entries, history } = get();
      if (!initialized) return;
      const session = history.find(item => item.id === sessionId);
      if (!session) return;

      const nextHistory = history.filter(item => item.id !== sessionId);
      commit(entries, nextHistory, session.entries.map(item => item.key));
    },

    clearHistory: () => {
      const { initialized, entries, history } = get();
      if (!initialized || history.length === 0) return;
      const touchedKeys = new Set<string>();
      for (const session of history) {
        for (const item of session.entries) touchedKeys.add(item.key);
      }
      commit(entries, [], touchedKeys);
    },

    importFromJson: rawJson => {
      const { initialized, entries, history } = get();
      if (!initialized) {
        throw new Error('Editor store is not initialized.');
      }

      const parsed = JSON.parse(rawJson) as unknown;
      let rawItems: unknown[];
      if (Array.isArray(parsed)) {
        rawItems = parsed;
      } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)) {
        const version = (parsed as { version?: unknown }).version;
        if (version !== undefined && version !== 1) {
          throw new TypeError(`Unsupported export version: ${String(version)}.`);
        }
        rawItems = (parsed as { entries: unknown[] }).entries;
      } else {
        throw new TypeError('Invalid JSON format: expected an object with an "entries" array.');
      }

      const importedEntries: Record<string, UiTextEditEntry> = {};
      let imported = 0;
      const now = new Date().toISOString();

      for (const item of rawItems) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        if (typeof rec.key !== 'string' || rec.key.trim().length === 0) continue;
        const key = rec.key.trim();
        const note = typeof rec.note === 'string' ? rec.note : '';
        const changes: Partial<Record<SupportedLanguage, LanguageChange>> = {};

        if (rec.changes && typeof rec.changes === 'object' && !Array.isArray(rec.changes)) {
          for (const [lang, rawChange] of Object.entries(rec.changes as Record<string, unknown>)) {
            if (!isSupportedLanguage(lang) || !rawChange || typeof rawChange !== 'object' || Array.isArray(rawChange)) continue;
            const ch = rawChange as Record<string, unknown>;
            if (typeof ch.before !== 'string' || typeof ch.after !== 'string') continue;
            changes[lang] = { before: ch.before, after: ch.after };
          }
        }

        if (Object.keys(changes).length === 0 && note.trim().length === 0) {
          continue;
        }

        importedEntries[key] = {
          key,
          changes,
          note,
          updatedAt: now,
        };
        imported += 1;
      }

      // No-op when nothing was parsed or when the imported set is identical to
      // the active session so repeated pastes never duplicate history entries.
      if (imported === 0 || areEntrySetsEqual(entries, importedEntries)) {
        return { imported, changed: false };
      }

      const archivedCurrent = buildHistorySession(entries, now);
      const { kept: nextHistory, evictedKeys } = capHistory(
        archivedCurrent ? [archivedCurrent, ...history] : history,
      );

      const touchedKeys = new Set<string>([
        ...Object.keys(entries),
        ...Object.keys(importedEntries),
        ...evictedKeys,
      ]);
      commit(importedEntries, nextHistory, touchedKeys);
      return { imported, changed: true };
    },
  };
});

export const __testing = {
  storageKey: STORAGE_KEY,
  reset(): void {
    initPromise = null;
    useUiTextEditorStore.setState({
      initialized: false,
      originals: emptyOriginals(),
      entries: {},
      history: [],
    });
  },
};
