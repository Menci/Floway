import { create } from 'zustand';

import { ensureLocaleLoaded, i18n } from '../index';
import { supportedLanguages, type SupportedLanguage } from '../languages';
import { loadLocale } from '../resources';

const DRAFTS_STORAGE_KEY = 'floway.copyEditorDrafts.v1';
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
  exportedAt: string | null;
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

const readStoredDrafts = (): Record<string, CopyDraftEntry> => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, CopyDraftEntry> = {};
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const rec = entry as Record<string, unknown>;
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
      const route = typeof rec.route === 'string' ? rec.route : '/';
      const updatedAt = typeof rec.updatedAt === 'string' ? rec.updatedAt : new Date().toISOString();
      const exportedAt = typeof rec.exportedAt === 'string' ? rec.exportedAt : null;
      if (Object.keys(changes).length > 0 || note.trim().length > 0) {
        out[key] = { key, route, changes, note, updatedAt, exportedAt };
      }
    }
    return out;
  } catch {
    return {};
  }
};

const writeStoredDrafts = (entries: Record<string, CopyDraftEntry>): void => {
  if (typeof window === 'undefined') return;
  try {
    if (Object.keys(entries).length === 0) {
      window.localStorage.removeItem(DRAFTS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(entries));
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
  // Always ensure the bundle exists in i18next before mutating a single key so
  // switching languages later keeps the full catalog intact.
  i18n.addResource(language, 'translation', key, value);
};

/**
 * Reconciles persisted drafts against the running build's locale catalogs.
 * Any language edit whose `after` matches the current build's original string
 * has already shipped and is pruned automatically.
 */
const reconcileDrafts = (
  raw: Record<string, CopyDraftEntry>,
  originals: OriginalsMap,
): { entries: Record<string, CopyDraftEntry>; prunedCount: number } => {
  const entries: Record<string, CopyDraftEntry> = {};
  let prunedCount = 0;

  for (const [key, entry] of Object.entries(raw)) {
    const nextChanges: Partial<Record<SupportedLanguage, LanguageChange>> = {};
    for (const language of supportedLanguages) {
      const change = entry.changes[language];
      if (!change) continue;
      const currentOriginal = originals[language].get(key);
      if (currentOriginal !== undefined && change.after === currentOriginal) {
        continue;
      }
      nextChanges[language] = change;
    }

    const trimmedNote = entry.note.trim();
    if (Object.keys(nextChanges).length === 0 && trimmedNote.length === 0) {
      prunedCount += 1;
      continue;
    }

    entries[key] = {
      ...entry,
      changes: nextChanges,
      note: entry.note,
    };
  }

  return { entries, prunedCount };
};

export interface CopyEditorStore {
  initialized: boolean;
  initializing: boolean;
  originals: OriginalsMap;
  entries: Record<string, CopyDraftEntry>;
  autoPrunedCount: number;
  ensureInitialized: () => Promise<void>;
  getOriginal: (language: SupportedLanguage, key: string) => string | undefined;
  getCurrent: (language: SupportedLanguage, key: string) => string | undefined;
  getRelatedKeys: (key: string) => string[];
  getStaleLanguages: (key: string) => SupportedLanguage[];
  stageEntry: (input: StageEntryInput) => void;
  revertEntry: (key: string) => void;
  revertLanguage: (key: string, language: SupportedLanguage) => void;
  clearExported: () => void;
  clearAll: () => void;
  buildExportPayload: (scope: 'unexported' | 'all') => CopyEditorExportPayload;
  markExported: (keys: string[], timestamp?: string) => void;
  importFromJson: (rawJson: string) => ImportResult;
}

let initPromise: Promise<void> | null = null;

export const useCopyEditorStore = create<CopyEditorStore>((set, get) => ({
  initialized: false,
  initializing: false,
  originals: emptyOriginals(),
  entries: {},
  autoPrunedCount: 0,

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

      const stored = readStoredDrafts();
      const { entries, prunedCount } = reconcileDrafts(stored, originals);
      if (prunedCount > 0) writeStoredDrafts(entries);

      // Re-apply all active drafts onto i18next so every usage on the page
      // immediately shows the staged copy.
      for (const entry of Object.values(entries)) {
        for (const language of supportedLanguages) {
          const change = entry.changes[language];
          if (change) applyResourceValue(language, entry.key, change.after);
        }
      }

      set({
        initialized: true,
        initializing: false,
        originals,
        entries,
        autoPrunedCount: prunedCount,
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
    const entry = get().entries[key];
    const changed = entry?.changes[language];
    if (changed) return changed.after;
    return get().originals[language].get(key);
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
    const { originals, entries } = get();
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
          applyResourceValue(language, key, nextValue);
        }
        continue;
      }
      if (nextValue !== original) {
        nextChanges[language] = { before: original, after: nextValue };
        applyResourceValue(language, key, nextValue);
      } else if (prev?.changes[language]) {
        applyResourceValue(language, key, original);
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
        // Any modification marks the entry dirty for export again.
        exportedAt: null,
      };
    }

    writeStoredDrafts(nextEntries);
    set({ entries: nextEntries });
  },

  revertLanguage: (key, language) => {
    const { originals, entries } = get();
    const prev = entries[key];
    if (!prev) return;
    const original = originals[language].get(key);
    if (original !== undefined) applyResourceValue(language, key, original);

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
        exportedAt: null,
      };
    }
    writeStoredDrafts(nextEntries);
    set({ entries: nextEntries });
  },

  revertEntry: key => {
    const { originals, entries } = get();
    const prev = entries[key];
    if (!prev) return;
    for (const language of supportedLanguages) {
      if (!prev.changes[language]) continue;
      const original = originals[language].get(key);
      if (original !== undefined) applyResourceValue(language, key, original);
    }
    const nextEntries = { ...entries };
    delete nextEntries[key];
    writeStoredDrafts(nextEntries);
    set({ entries: nextEntries });
  },

  clearExported: () => {
    const { originals, entries } = get();
    const nextEntries: Record<string, CopyDraftEntry> = {};
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.exportedAt !== null) {
        for (const language of supportedLanguages) {
          if (!entry.changes[language]) continue;
          const original = originals[language].get(key);
          if (original !== undefined) applyResourceValue(language, key, original);
        }
      } else {
        nextEntries[key] = entry;
      }
    }
    writeStoredDrafts(nextEntries);
    set({ entries: nextEntries });
  },

  clearAll: () => {
    const { originals, entries } = get();
    for (const [key, entry] of Object.entries(entries)) {
      for (const language of supportedLanguages) {
        if (!entry.changes[language]) continue;
        const original = originals[language].get(key);
        if (original !== undefined) applyResourceValue(language, key, original);
      }
    }
    writeStoredDrafts({});
    set({ entries: {} });
  },

  buildExportPayload: scope => {
    const all = Object.values(get().entries).sort((a, b) => a.key.localeCompare(b.key));
    const filtered = scope === 'unexported' ? all.filter(entry => entry.exportedAt === null) : all;
    const exportedAt = new Date().toISOString();
    const entries: ExportedCopyChange[] = filtered.map(entry => {
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
    return {
      version: 1,
      exportedAt,
      entries,
    };
  },

  markExported: (keys, timestamp = new Date().toISOString()) => {
    const { entries } = get();
    const keySet = new Set(keys);
    const nextEntries: Record<string, CopyDraftEntry> = {};
    for (const [key, entry] of Object.entries(entries)) {
      nextEntries[key] = keySet.has(key) ? { ...entry, exportedAt: timestamp } : entry;
    }
    writeStoredDrafts(nextEntries);
    set({ entries: nextEntries });
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

    const { originals, entries } = get();
    const nextEntries = { ...entries };
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
          applyResourceValue(lang, key, ch.after);
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
        exportedAt: null,
      };
      imported += 1;
    }

    writeStoredDrafts(nextEntries);
    set({ entries: nextEntries });
    return { imported, skippedUpToDate };
  },
}));

export const __testing = {
  storageKey: DRAFTS_STORAGE_KEY,
  reset(): void {
    initPromise = null;
    useCopyEditorStore.setState({
      initialized: false,
      initializing: false,
      originals: emptyOriginals(),
      entries: {},
      autoPrunedCount: 0,
    });
  },
};
