import { create } from 'zustand';

import { ensureLocaleLoaded, i18n } from '../index';
import { supportedLanguages, type SupportedLanguage } from '../languages';
import { loadLocale } from '../resources';

const STORAGE_KEY = 'floway.copyEditorState.v4';
const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;

export interface LanguageChange {
  before: string;
  after: string;
}

export interface CopyDraftEntry {
  key: string;
  changes: Partial<Record<SupportedLanguage, LanguageChange>>;
  note: string;
  updatedAt: string;
}

export interface CopyHistorySession {
  id: string;
  archivedAt: string;
  entries: CopyDraftEntry[];
}

export interface ExportedCopyChange {
  key: string;
  changes?: Partial<Record<SupportedLanguage, LanguageChange>>;
  note?: string;
}

export interface CopyEditorExportPayload {
  version: 1;
  exportedAt: string;
  entries: ExportedCopyChange[];
}

export interface StageEntryInput {
  key: string;
  values: Partial<Record<SupportedLanguage, string>>;
  note: string;
}

export interface ImportResult {
  imported: number;
  changed: boolean;
}

interface PersistedState {
  entries: Record<string, CopyDraftEntry>;
  history: CopyHistorySession[];
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

export const pluralBaseOf = (key: string): string => key.replace(PLURAL_SUFFIX_RE, '');

const isSupportedLanguage = (value: string): value is SupportedLanguage =>
  (supportedLanguages as readonly string[]).includes(value);

const parseEntry = (raw: unknown, fallbackKey?: string): CopyDraftEntry | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const key = typeof rec.key === 'string' && rec.key.trim().length > 0 ? rec.key.trim() : fallbackKey;
  if (!key) return null;

  const changes: Partial<Record<SupportedLanguage, LanguageChange>> = {};
  if (rec.changes && typeof rec.changes === 'object' && !Array.isArray(rec.changes)) {
    for (const [lang, change] of Object.entries(rec.changes as Record<string, unknown>)) {
      if (!isSupportedLanguage(lang) || !change || typeof change !== 'object') continue;
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

    const entries: Record<string, CopyDraftEntry> = {};
    if (rec.entries && typeof rec.entries === 'object' && !Array.isArray(rec.entries)) {
      for (const [k, rawEntry] of Object.entries(rec.entries as Record<string, unknown>)) {
        const entry = parseEntry(rawEntry, k);
        if (entry) entries[entry.key] = entry;
      }
    }

    const history: CopyHistorySession[] = [];
    if (Array.isArray(rec.history)) {
      for (const rawSession of rec.history) {
        if (!rawSession || typeof rawSession !== 'object' || Array.isArray(rawSession)) continue;
        const sessionRec = rawSession as Record<string, unknown>;
        const id = typeof sessionRec.id === 'string' && sessionRec.id.length > 0 ? sessionRec.id : null;
        const archivedAt = typeof sessionRec.archivedAt === 'string' ? sessionRec.archivedAt : null;
        if (!id || !archivedAt || !Array.isArray(sessionRec.entries)) continue;
        const sessionEntries = sessionRec.entries
          .map(item => parseEntry(item))
          .filter((item): item is CopyDraftEntry => item !== null);
        if (sessionEntries.length > 0) {
          history.push({ id, archivedAt, entries: sessionEntries });
        }
      }
    }

    return { entries, history };
  } catch {
    return { entries: {}, history: [] };
  }
};

const writeStoredState = (state: PersistedState): void => {
  if (typeof window === 'undefined') return;
  try {
    if (Object.keys(state.entries).length === 0 && state.history.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  } catch {
    // Ignore storage quota or restricted-mode errors.
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

/**
 * Resolves the effective override for `(language, key)` across history
 * sessions (newest first) and active drafts (highest precedence).
 */
const resolveEffectiveValue = (
  language: SupportedLanguage,
  key: string,
  originals: OriginalsMap,
  entries: Record<string, CopyDraftEntry>,
  history: CopyHistorySession[],
): string | undefined => {
  const active = entries[key]?.changes[language];
  if (active) return active.after;

  for (const session of history) {
    const match = session.entries.find(item => item.key === key);
    const change = match?.changes[language];
    if (change) return change.after;
  }

  return originals[language].get(key);
};

const syncKeysToI18n = (
  keys: Iterable<string>,
  originals: OriginalsMap,
  entries: Record<string, CopyDraftEntry>,
  history: CopyHistorySession[],
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

const formatExportEntries = (list: CopyDraftEntry[]): ExportedCopyChange[] =>
  [...list]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(entry => {
      const item: ExportedCopyChange = {
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

const areEntrySetsEqual = (
  a: Record<string, CopyDraftEntry>,
  b: Record<string, CopyDraftEntry>,
): boolean => {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    const ea = a[key];
    const eb = b[key];
    if (!ea || !eb) return false;
    if (ea.note.trim() !== eb.note.trim()) return false;
    for (const lang of supportedLanguages) {
      const ca = ea.changes[lang];
      const cb = eb.changes[lang];
      if ((ca === undefined) !== (cb === undefined)) return false;
      if (ca && cb && (ca.before !== cb.before || ca.after !== cb.after)) return false;
    }
  }
  return true;
};

const buildHistorySession = (
  entries: Record<string, CopyDraftEntry>,
  archivedAt: string,
): CopyHistorySession | null => {
  const list = Object.values(entries).sort((a, b) => a.key.localeCompare(b.key));
  if (list.length === 0) return null;
  return {
    id: makeSessionId(archivedAt),
    archivedAt,
    entries: list,
  };
};

export interface CopyEditorStore {
  initialized: boolean;
  initializing: boolean;
  originals: OriginalsMap;
  entries: Record<string, CopyDraftEntry>;
  history: CopyHistorySession[];
  ensureInitialized: () => Promise<void>;
  getOriginal: (language: SupportedLanguage, key: string) => string | undefined;
  getCurrent: (language: SupportedLanguage, key: string) => string | undefined;
  getRelatedKeys: (key: string) => string[];
  stageEntry: (input: StageEntryInput) => void;
  revertEntry: (key: string) => void;
  revertLanguage: (key: string, language: SupportedLanguage) => void;
  clearActive: () => void;
  buildExportPayload: () => CopyEditorExportPayload;
  buildHistoryExportPayload: (sessionId: string) => CopyEditorExportPayload | null;
  archiveActiveAsExport: (archivedAt?: string) => CopyHistorySession | null;
  restoreHistorySession: (sessionId: string) => void;
  deleteHistorySession: (sessionId: string) => void;
  clearHistory: () => void;
  importFromJson: (rawJson: string) => ImportResult;
}

let initPromise: Promise<void> | null = null;

export const useCopyEditorStore = create<CopyEditorStore>((set, get) => ({
  initialized: false,
  initializing: false,
  originals: emptyOriginals(),
  entries: {},
  history: [],

  ensureInitialized: async () => {
    if (get().initialized) return;
    if (initPromise) return await initPromise;

    set({ initializing: true });
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
        initializing: false,
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

  getRelatedKeys: key => {
    const { originals } = get();
    const base = pluralBaseOf(key);
    const found = new Set<string>();
    for (const language of supportedLanguages) {
      for (const leaf of originals[language].keys()) {
        if (leaf === key || pluralBaseOf(leaf) === base) {
          found.add(leaf);
        }
      }
    }
    if (found.size === 0) return [key];
    return [...found].sort((a, b) => {
      if (a === key) return -1;
      if (b === key) return 1;
      return a.localeCompare(b);
    });
  },

  stageEntry: ({ key, values, note }) => {
    const { originals, entries, history } = get();
    const prev = entries[key];
    const nextChanges: Partial<Record<SupportedLanguage, LanguageChange>> = {};

    for (const language of supportedLanguages) {
      const original = originals[language].get(key);
      const nextValue = values[language];
      if (nextValue === undefined) {
        if (prev?.changes[language]) nextChanges[language] = prev.changes[language];
        continue;
      }
      if (original === undefined) {
        if (nextValue.length > 0) {
          nextChanges[language] = { before: prev?.changes[language]?.before ?? '', after: nextValue };
        }
        continue;
      }
      if (nextValue !== original) {
        nextChanges[language] = { before: original, after: nextValue };
      } else if (prev?.changes[language]?.after === original) {
        // Keep an already-applied entry intact when editing another field on the same key.
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

    syncKeysToI18n([key], originals, nextEntries, history);
    writeStoredState({ entries: nextEntries, history });
    set({ entries: nextEntries });
  },

  revertLanguage: (key, language) => {
    const { originals, entries, history } = get();
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

    syncKeysToI18n([key], originals, nextEntries, history);
    writeStoredState({ entries: nextEntries, history });
    set({ entries: nextEntries });
  },

  revertEntry: key => {
    const { originals, entries, history } = get();
    if (!entries[key]) return;
    const nextEntries = { ...entries };
    delete nextEntries[key];
    syncKeysToI18n([key], originals, nextEntries, history);
    writeStoredState({ entries: nextEntries, history });
    set({ entries: nextEntries });
  },

  clearActive: () => {
    const { originals, entries, history } = get();
    const touched = Object.keys(entries);
    if (touched.length === 0) return;
    syncKeysToI18n(touched, originals, {}, history);
    writeStoredState({ entries: {}, history });
    set({ entries: {} });
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

  archiveActiveAsExport: (archivedAt = new Date().toISOString()) => {
    const { entries, history } = get();
    const session = buildHistorySession(entries, archivedAt);
    if (!session) return null;

    const nextHistory = [session, ...history];
    writeStoredState({ entries: {}, history: nextHistory });
    set({ entries: {}, history: nextHistory });
    return session;
  },

  restoreHistorySession: sessionId => {
    const { originals, entries, history } = get();
    const target = history.find(item => item.id === sessionId);
    if (!target) return;

    const now = new Date().toISOString();
    const archivedCurrent = buildHistorySession(entries, now);
    const remaining = history.filter(item => item.id !== sessionId);
    const nextHistory = archivedCurrent ? [archivedCurrent, ...remaining] : remaining;

    const nextEntries: Record<string, CopyDraftEntry> = {};
    const touchedKeys = new Set<string>(Object.keys(entries));
    for (const item of target.entries) {
      nextEntries[item.key] = { ...item };
      touchedKeys.add(item.key);
    }

    syncKeysToI18n(touchedKeys, originals, nextEntries, nextHistory);
    writeStoredState({ entries: nextEntries, history: nextHistory });
    set({ entries: nextEntries, history: nextHistory });
  },

  deleteHistorySession: sessionId => {
    const { originals, entries, history } = get();
    const session = history.find(item => item.id === sessionId);
    if (!session) return;

    const nextHistory = history.filter(item => item.id !== sessionId);
    syncKeysToI18n(session.entries.map(item => item.key), originals, entries, nextHistory);
    writeStoredState({ entries, history: nextHistory });
    set({ history: nextHistory });
  },

  clearHistory: () => {
    const { originals, entries, history } = get();
    if (history.length === 0) return;
    const touchedKeys = new Set<string>();
    for (const session of history) {
      for (const item of session.entries) touchedKeys.add(item.key);
    }
    syncKeysToI18n(touchedKeys, originals, entries, []);
    writeStoredState({ entries, history: [] });
    set({ history: [] });
  },

  importFromJson: rawJson => {
    const parsed = JSON.parse(rawJson) as unknown;
    let rawItems: unknown[];
    if (Array.isArray(parsed)) {
      rawItems = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)) {
      rawItems = (parsed as { entries: unknown[] }).entries;
    } else {
      throw new TypeError('Invalid JSON format: expected an object with an "entries" array.');
    }

    const { originals, entries, history } = get();
    const importedEntries: Record<string, CopyDraftEntry> = {};
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
          if (!isSupportedLanguage(lang) || !rawChange || typeof rawChange !== 'object') continue;
          const ch = rawChange as Record<string, unknown>;
          if (typeof ch.after !== 'string') continue;
          const currentOriginal = originals[lang].get(key);
          const before = typeof ch.before === 'string' ? ch.before : (currentOriginal ?? '');
          changes[lang] = { before, after: ch.after };
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
    const nextHistory = archivedCurrent ? [archivedCurrent, ...history] : history;

    const touchedKeys = new Set<string>([
      ...Object.keys(entries),
      ...Object.keys(importedEntries),
    ]);
    syncKeysToI18n(touchedKeys, originals, importedEntries, nextHistory);
    writeStoredState({ entries: importedEntries, history: nextHistory });
    set({ entries: importedEntries, history: nextHistory });
    return { imported, changed: true };
  },
}));

export const __testing = {
  storageKey: STORAGE_KEY,
  reset(): void {
    initPromise = null;
    useCopyEditorStore.setState({
      initialized: false,
      initializing: false,
      originals: emptyOriginals(),
      entries: {},
      history: [],
    });
  },
};
