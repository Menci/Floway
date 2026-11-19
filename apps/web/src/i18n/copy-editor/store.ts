import { create } from 'zustand';

import { ensureLocaleLoaded, i18n } from '../index';
import { supportedLanguages, type SupportedLanguage } from '../languages';
import { loadLocale } from '../resources';

const STORAGE_KEY = 'floway.copyEditorState.v2';
const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;

export interface LanguageChange {
  before: string;
  after: string;
}

export interface CopyDraftEntry {
  key: string;
  route: string;
  changes: Partial<Record<SupportedLanguage, LanguageChange>>;
  note: string;
  updatedAt: string;
}

export interface ExportedBatch {
  id: string;
  exportedAt: string;
  entries: CopyDraftEntry[];
}

export interface ExportedCopyChange {
  key: string;
  route: string;
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
  route: string;
  values: Partial<Record<SupportedLanguage, string>>;
  note: string;
}

export interface ImportResult {
  imported: number;
  skippedUpToDate: number;
}

interface PersistedState {
  entries: Record<string, CopyDraftEntry>;
  exports: ExportedBatch[];
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

  const route = typeof rec.route === 'string' ? rec.route : '/';
  const updatedAt = typeof rec.updatedAt === 'string' ? rec.updatedAt : new Date().toISOString();
  return { key, route, changes, note, updatedAt };
};

const readStoredState = (): PersistedState => {
  if (typeof window === 'undefined') return { entries: {}, exports: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { entries: {}, exports: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { entries: {}, exports: [] };
    }
    const rec = parsed as Record<string, unknown>;

    const entries: Record<string, CopyDraftEntry> = {};
    if (rec.entries && typeof rec.entries === 'object' && !Array.isArray(rec.entries)) {
      for (const [k, rawEntry] of Object.entries(rec.entries as Record<string, unknown>)) {
        const entry = parseEntry(rawEntry, k);
        if (entry) entries[entry.key] = entry;
      }
    }

    const exports: ExportedBatch[] = [];
    if (Array.isArray(rec.exports)) {
      for (const rawBatch of rec.exports) {
        if (!rawBatch || typeof rawBatch !== 'object' || Array.isArray(rawBatch)) continue;
        const batchRec = rawBatch as Record<string, unknown>;
        const id = typeof batchRec.id === 'string' && batchRec.id.length > 0 ? batchRec.id : null;
        const exportedAt = typeof batchRec.exportedAt === 'string' ? batchRec.exportedAt : null;
        if (!id || !exportedAt || !Array.isArray(batchRec.entries)) continue;
        const batchEntries = batchRec.entries
          .map(item => parseEntry(item))
          .filter((item): item is CopyDraftEntry => item !== null);
        if (batchEntries.length > 0) {
          exports.push({ id, exportedAt, entries: batchEntries });
        }
      }
    }

    return { entries, exports };
  } catch {
    return { entries: {}, exports: [] };
  }
};

const writeStoredState = (state: PersistedState): void => {
  if (typeof window === 'undefined') return;
  try {
    if (Object.keys(state.entries).length === 0 && state.exports.length === 0) {
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

const reconcileEntry = (entry: CopyDraftEntry, originals: OriginalsMap): CopyDraftEntry | null => {
  const nextChanges: Partial<Record<SupportedLanguage, LanguageChange>> = {};
  for (const language of supportedLanguages) {
    const change = entry.changes[language];
    if (!change) continue;
    const currentOriginal = originals[language].get(keyOf(entry));
    if (currentOriginal !== undefined && change.after === currentOriginal) {
      continue;
    }
    nextChanges[language] = change;
  }
  if (Object.keys(nextChanges).length === 0 && entry.note.trim().length === 0) {
    return null;
  }
  return { ...entry, changes: nextChanges };
};

const keyOf = (entry: CopyDraftEntry): string => entry.key;

/**
 * Reconciles active drafts and archived export batches against the running
 * build's locale catalogs, silently pruning any edit that has already shipped.
 */
const reconcileState = (
  raw: PersistedState,
  originals: OriginalsMap,
): { state: PersistedState; changed: boolean } => {
  let changed = false;
  const entries: Record<string, CopyDraftEntry> = {};

  for (const entry of Object.values(raw.entries)) {
    const reconciled = reconcileEntry(entry, originals);
    if (!reconciled) {
      changed = true;
      continue;
    }
    if (Object.keys(reconciled.changes).length !== Object.keys(entry.changes).length) {
      changed = true;
    }
    entries[reconciled.key] = reconciled;
  }

  const exports: ExportedBatch[] = [];
  for (const batch of raw.exports) {
    const nextBatchEntries: CopyDraftEntry[] = [];
    for (const entry of batch.entries) {
      const reconciled = reconcileEntry(entry, originals);
      if (!reconciled) {
        changed = true;
        continue;
      }
      if (Object.keys(reconciled.changes).length !== Object.keys(entry.changes).length) {
        changed = true;
      }
      nextBatchEntries.push(reconciled);
    }
    if (nextBatchEntries.length > 0) {
      exports.push({ ...batch, entries: nextBatchEntries });
    } else {
      changed = true;
    }
  }

  return { state: { entries, exports }, changed };
};

/**
 * Resolves the effective override for `(language, key)` across archived
 * exports (oldest to newest) and active drafts (highest precedence).
 */
const resolveEffectiveValue = (
  language: SupportedLanguage,
  key: string,
  originals: OriginalsMap,
  entries: Record<string, CopyDraftEntry>,
  exports: ExportedBatch[],
): string | undefined => {
  const active = entries[key]?.changes[language];
  if (active) return active.after;

  // `exports` is stored newest-first, so the first match is the latest archived override.
  for (const batch of exports) {
    const match = batch.entries.find(item => item.key === key);
    const change = match?.changes[language];
    if (change) return change.after;
  }

  return originals[language].get(key);
};

const syncKeysToI18n = (
  keys: Iterable<string>,
  originals: OriginalsMap,
  entries: Record<string, CopyDraftEntry>,
  exports: ExportedBatch[],
): void => {
  for (const key of keys) {
    for (const language of supportedLanguages) {
      const value = resolveEffectiveValue(language, key, originals, entries, exports);
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
        route: entry.route,
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

const makeBatchId = (exportedAt: string): string =>
  `${exportedAt}-${Math.random().toString(36).slice(2, 8)}`;

export interface CopyEditorStore {
  initialized: boolean;
  initializing: boolean;
  originals: OriginalsMap;
  entries: Record<string, CopyDraftEntry>;
  exports: ExportedBatch[];
  ensureInitialized: () => Promise<void>;
  getOriginal: (language: SupportedLanguage, key: string) => string | undefined;
  getCurrent: (language: SupportedLanguage, key: string) => string | undefined;
  getRelatedKeys: (key: string) => string[];
  getStaleLanguages: (key: string) => SupportedLanguage[];
  stageEntry: (input: StageEntryInput) => void;
  revertEntry: (key: string) => void;
  revertLanguage: (key: string, language: SupportedLanguage) => void;
  clearActive: () => void;
  buildExportPayload: () => CopyEditorExportPayload;
  buildBatchExportPayload: (batchId: string) => CopyEditorExportPayload | null;
  archiveActiveAsExport: (exportedAt?: string) => ExportedBatch | null;
  restoreExportBatch: (batchId: string) => void;
  deleteExportBatch: (batchId: string) => void;
  clearExports: () => void;
  importFromJson: (rawJson: string) => ImportResult;
}

let initPromise: Promise<void> | null = null;

export const useCopyEditorStore = create<CopyEditorStore>((set, get) => ({
  initialized: false,
  initializing: false,
  originals: emptyOriginals(),
  entries: {},
  exports: [],

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

      const stored = readStoredState();
      const { state, changed } = reconcileState(stored, originals);
      if (changed) writeStoredState(state);

      // Apply archived exports oldest-first, then active drafts on top, so
      // previously exported edits remain silently active on the page.
      const touchedKeys = new Set<string>();
      for (const batch of state.exports) {
        for (const entry of batch.entries) touchedKeys.add(entry.key);
      }
      for (const key of Object.keys(state.entries)) touchedKeys.add(key);
      syncKeysToI18n(touchedKeys, originals, state.entries, state.exports);

      set({
        initialized: true,
        initializing: false,
        originals,
        entries: state.entries,
        exports: state.exports,
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
    const { originals, entries, exports } = get();
    return resolveEffectiveValue(language, key, originals, entries, exports);
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

  getStaleLanguages: key => {
    const entry = get().entries[key];
    if (!entry) return [];
    const { originals } = get();
    const stale: SupportedLanguage[] = [];
    for (const language of supportedLanguages) {
      const change = entry.changes[language];
      if (!change) continue;
      const original = originals[language].get(key);
      if (original !== undefined && original !== change.before && original !== change.after) {
        stale.push(language);
      }
    }
    return stale;
  },

  stageEntry: ({ key, route, values, note }) => {
    const { originals, entries, exports } = get();
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
      }
    }

    const trimmedNote = note.trim();
    const nextEntries = { ...entries };
    if (Object.keys(nextChanges).length === 0 && trimmedNote.length === 0) {
      delete nextEntries[key];
    } else {
      nextEntries[key] = {
        key,
        route,
        changes: nextChanges,
        note,
        updatedAt: new Date().toISOString(),
      };
    }

    syncKeysToI18n([key], originals, nextEntries, exports);
    writeStoredState({ entries: nextEntries, exports });
    set({ entries: nextEntries });
  },

  revertLanguage: (key, language) => {
    const { originals, entries, exports } = get();
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

    syncKeysToI18n([key], originals, nextEntries, exports);
    writeStoredState({ entries: nextEntries, exports });
    set({ entries: nextEntries });
  },

  revertEntry: key => {
    const { originals, entries, exports } = get();
    if (!entries[key]) return;
    const nextEntries = { ...entries };
    delete nextEntries[key];
    syncKeysToI18n([key], originals, nextEntries, exports);
    writeStoredState({ entries: nextEntries, exports });
    set({ entries: nextEntries });
  },

  clearActive: () => {
    const { originals, entries, exports } = get();
    const touched = Object.keys(entries);
    if (touched.length === 0) return;
    syncKeysToI18n(touched, originals, {}, exports);
    writeStoredState({ entries: {}, exports });
    set({ entries: {} });
  },

  buildExportPayload: () => ({
    version: 1,
    exportedAt: new Date().toISOString(),
    entries: formatExportEntries(Object.values(get().entries)),
  }),

  buildBatchExportPayload: batchId => {
    const batch = get().exports.find(item => item.id === batchId);
    if (!batch) return null;
    return {
      version: 1,
      exportedAt: batch.exportedAt,
      entries: formatExportEntries(batch.entries),
    };
  },

  archiveActiveAsExport: (exportedAt = new Date().toISOString()) => {
    const { entries, exports } = get();
    const activeList = Object.values(entries).sort((a, b) => a.key.localeCompare(b.key));
    if (activeList.length === 0) return null;

    const batch: ExportedBatch = {
      id: makeBatchId(exportedAt),
      exportedAt,
      entries: activeList,
    };
    const nextExports = [batch, ...exports];
    // Archived entries stay applied in i18next; only the active list clears.
    writeStoredState({ entries: {}, exports: nextExports });
    set({ entries: {}, exports: nextExports });
    return batch;
  },

  restoreExportBatch: batchId => {
    const { originals, entries, exports } = get();
    const batch = exports.find(item => item.id === batchId);
    if (!batch) return;

    const nextEntries = { ...entries };
    const touchedKeys: string[] = [];
    for (const archived of batch.entries) {
      touchedKeys.push(archived.key);
      const current = nextEntries[archived.key];
      if (!current) {
        nextEntries[archived.key] = { ...archived };
      } else {
        // Merge archived languages/note beneath any newer active edits on the same key.
        nextEntries[archived.key] = {
          ...archived,
          ...current,
          changes: { ...archived.changes, ...current.changes },
          note: current.note.trim().length > 0 ? current.note : archived.note,
        };
      }
    }

    const nextExports = exports.filter(item => item.id !== batchId);
    syncKeysToI18n(touchedKeys, originals, nextEntries, nextExports);
    writeStoredState({ entries: nextEntries, exports: nextExports });
    set({ entries: nextEntries, exports: nextExports });
  },

  deleteExportBatch: batchId => {
    const { originals, entries, exports } = get();
    const batch = exports.find(item => item.id === batchId);
    if (!batch) return;

    const nextExports = exports.filter(item => item.id !== batchId);
    syncKeysToI18n(batch.entries.map(item => item.key), originals, entries, nextExports);
    writeStoredState({ entries, exports: nextExports });
    set({ exports: nextExports });
  },

  clearExports: () => {
    const { originals, entries, exports } = get();
    if (exports.length === 0) return;
    const touchedKeys = new Set<string>();
    for (const batch of exports) {
      for (const item of batch.entries) touchedKeys.add(item.key);
    }
    syncKeysToI18n(touchedKeys, originals, entries, []);
    writeStoredState({ entries, exports: [] });
    set({ exports: [] });
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

    const { originals, entries, exports } = get();
    const nextEntries = { ...entries };
    const touchedKeys: string[] = [];
    let imported = 0;
    let skippedUpToDate = 0;

    for (const item of rawItems) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.key !== 'string' || rec.key.trim().length === 0) continue;
      const key = rec.key.trim();
      const route = typeof rec.route === 'string' ? rec.route : '/';
      const note = typeof rec.note === 'string' ? rec.note : '';
      const changes: Partial<Record<SupportedLanguage, LanguageChange>> = {};

      if (rec.changes && typeof rec.changes === 'object' && !Array.isArray(rec.changes)) {
        for (const [lang, rawChange] of Object.entries(rec.changes as Record<string, unknown>)) {
          if (!isSupportedLanguage(lang) || !rawChange || typeof rawChange !== 'object') continue;
          const ch = rawChange as Record<string, unknown>;
          if (typeof ch.after !== 'string') continue;
          const currentOriginal = originals[lang].get(key);
          if (currentOriginal !== undefined && ch.after === currentOriginal) {
            continue;
          }
          const before = typeof ch.before === 'string' ? ch.before : (currentOriginal ?? '');
          changes[lang] = { before, after: ch.after };
        }
      }

      if (Object.keys(changes).length === 0 && note.trim().length === 0) {
        skippedUpToDate += 1;
        continue;
      }

      nextEntries[key] = {
        key,
        route,
        changes,
        note,
        updatedAt: new Date().toISOString(),
      };
      touchedKeys.push(key);
      imported += 1;
    }

    syncKeysToI18n(touchedKeys, originals, nextEntries, exports);
    writeStoredState({ entries: nextEntries, exports });
    set({ entries: nextEntries });
    return { imported, skippedUpToDate };
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
      exports: [],
    });
  },
};
