export interface LanguageChange {
  before: string;
  after: string;
}

export interface UiTextEditEntry<Lang extends string = string> {
  key: string;
  changes: Partial<Record<Lang, LanguageChange>>;
  note: string;
  updatedAt: string;
}

export interface UiTextHistorySession<Lang extends string = string> {
  id: string;
  archivedAt: string;
  entries: UiTextEditEntry<Lang>[];
}

export interface ExportedUiTextChange<Lang extends string = string> {
  key: string;
  changes?: Partial<Record<Lang, LanguageChange>>;
  note?: string;
}

export interface UiTextEditorExportPayload<Lang extends string = string> {
  version: 1;
  exportedAt: string;
  entries: ExportedUiTextChange<Lang>[];
}

export interface ExportSnapshot<Lang extends string = string> {
  payload: UiTextEditorExportPayload<Lang>;
  entries: Record<string, UiTextEditEntry<Lang>>;
}

export interface SaveEntryInput<Lang extends string = string> {
  key: string;
  values: Partial<Record<Lang, string>>;
  note: string;
}

export interface ImportResult {
  imported: number;
  changed: boolean;
}

export interface UiTextEditorState<Lang extends string = string> {
  initialized: boolean;
  originals: Record<Lang, Map<string, string>>;
  entries: Record<string, UiTextEditEntry<Lang>>;
  history: UiTextHistorySession<Lang>[];
}

export interface UiTextEditorActions<Lang extends string = string> {
  ensureInitialized: () => Promise<void>;
  getOriginal: (language: Lang, key: string) => string | undefined;
  getCurrent: (language: Lang, key: string) => string | undefined;
  saveEntry: (input: SaveEntryInput<Lang>) => boolean;
  revertEntry: (key: string) => void;
  revertLanguage: (key: string, language: Lang) => void;
  clearActive: () => void;
  createExportSnapshot: () => ExportSnapshot<Lang> | null;
  buildHistoryExportPayload: (sessionId: string) => UiTextEditorExportPayload<Lang> | null;
  commitExportSnapshot: (snapshot: ExportSnapshot<Lang>) => UiTextHistorySession<Lang> | null;
  restoreHistorySession: (sessionId: string) => void;
  deleteHistorySession: (sessionId: string) => void;
  clearHistory: () => void;
  importFromJson: (rawJson: string) => ImportResult;
}

export type UiTextEditorSnapshot<Lang extends string = string> = UiTextEditorState<Lang> & UiTextEditorActions<Lang>;

export interface UiTextEditorEngineConfig<Lang extends string> {
  languages: readonly Lang[];
  storageKey: string;
  maxHistorySessions?: number;
  loadLanguageCatalog: (language: Lang) => Promise<Map<string, string>>;
  applyResourceValue: (language: Lang, key: string, value: string) => void;
  isSafeForLiveProjection?: (original: string, candidate: string) => boolean;
}

export interface UiTextEditorEngine<Lang extends string> {
  getState: () => UiTextEditorSnapshot<Lang>;
  subscribe: (listener: () => void) => () => void;
  reset: () => void;
  storageKey: string;
}

interface PersistedState<Lang extends string> {
  entries: Record<string, UiTextEditEntry<Lang>>;
  history: UiTextHistorySession<Lang>[];
}

export const flattenCatalogLeaves = (value: object, prefix = ''): Map<string, string> => {
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

export const createUiTextEditorEngine = <Lang extends string>(
  config: UiTextEditorEngineConfig<Lang>,
): UiTextEditorEngine<Lang> => {
  const {
    languages,
    storageKey,
    maxHistorySessions = 200,
    loadLanguageCatalog,
    applyResourceValue,
    isSafeForLiveProjection = () => true,
  } = config;

  const languageSet = new Set<string>(languages);
  const isSupportedLanguage = (value: string): value is Lang => languageSet.has(value);

  const emptyOriginals = (): Record<Lang, Map<string, string>> => {
    const out = {} as Record<Lang, Map<string, string>>;
    for (const lang of languages) {
      out[lang] = new Map<string, string>();
    }
    return out;
  };

  const parseEntry = (raw: unknown, fallbackKey?: string): UiTextEditEntry<Lang> | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const key = typeof rec.key === 'string' && rec.key.trim().length > 0 ? rec.key.trim() : fallbackKey;
    if (!key) return null;

    const changes: Partial<Record<Lang, LanguageChange>> = {};
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

  const readStoredState = (): PersistedState<Lang> => {
    if (typeof window === 'undefined') return { entries: {}, history: [] };
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return { entries: {}, history: [] };
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { entries: {}, history: [] };
      }
      const rec = parsed as Record<string, unknown>;

      const entries: Record<string, UiTextEditEntry<Lang>> = {};
      if (rec.entries && typeof rec.entries === 'object' && !Array.isArray(rec.entries)) {
        for (const [k, rawEntry] of Object.entries(rec.entries as Record<string, unknown>)) {
          const entry = parseEntry(rawEntry, k);
          if (entry) entries[entry.key] = entry;
        }
      }

      const history: UiTextHistorySession<Lang>[] = [];
      if (Array.isArray(rec.history)) {
        for (const rawSession of rec.history) {
          if (!rawSession || typeof rawSession !== 'object' || Array.isArray(rawSession)) continue;
          const sessionRec = rawSession as Record<string, unknown>;
          const id = typeof sessionRec.id === 'string' && sessionRec.id.length > 0 ? sessionRec.id : null;
          const archivedAt = typeof sessionRec.archivedAt === 'string' ? sessionRec.archivedAt : null;
          if (!id || !archivedAt || !Array.isArray(sessionRec.entries)) continue;
          const sessionEntries = sessionRec.entries
            .map(item => parseEntry(item))
            .filter((item): item is UiTextEditEntry<Lang> => item !== null);
          if (sessionEntries.length > 0) {
            history.push({ id, archivedAt, entries: sessionEntries });
          }
        }
      }

      return { entries, history: history.slice(0, maxHistorySessions) };
    } catch {
      return { entries: {}, history: [] };
    }
  };

  const writeStoredState = (state: PersistedState<Lang>): boolean => {
    if (typeof window === 'undefined') return true;
    try {
      if (Object.keys(state.entries).length === 0 && state.history.length === 0) {
        window.localStorage.removeItem(storageKey);
      } else {
        window.localStorage.setItem(storageKey, JSON.stringify(state));
      }
      return true;
    } catch {
      return false;
    }
  };

  // Resolves the live override for `(language, key)` across history sessions
  // (newest first) and active edits (highest precedence). An edit takes effect
  // only when its recorded `before` matches the running build's original string
  // and its `after` passes live formatter safety.
  const resolveEffectiveValue = (
    language: Lang,
    key: string,
    originals: Record<Lang, Map<string, string>>,
    entries: Record<string, UiTextEditEntry<Lang>>,
    history: UiTextHistorySession<Lang>[],
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
    sessions: UiTextHistorySession<Lang>[],
  ): { kept: UiTextHistorySession<Lang>[]; evictedKeys: string[] } => {
    if (sessions.length <= maxHistorySessions) {
      return { kept: sessions, evictedKeys: [] };
    }
    const kept = sessions.slice(0, maxHistorySessions);
    const evictedKeys: string[] = [];
    for (const session of sessions.slice(maxHistorySessions)) {
      for (const entry of session.entries) evictedKeys.push(entry.key);
    }
    return { kept, evictedKeys };
  };

  const syncKeysToAdapter = (
    keys: Iterable<string>,
    originals: Record<Lang, Map<string, string>>,
    entries: Record<string, UiTextEditEntry<Lang>>,
    history: UiTextHistorySession<Lang>[],
  ): void => {
    for (const key of keys) {
      for (const language of languages) {
        const value = resolveEffectiveValue(language, key, originals, entries, history);
        if (value !== undefined) {
          applyResourceValue(language, key, value);
        }
      }
    }
  };

  const formatExportEntries = (list: UiTextEditEntry<Lang>[]): ExportedUiTextChange<Lang>[] =>
    [...list]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(entry => {
        const item: ExportedUiTextChange<Lang> = { key: entry.key };
        if (Object.keys(entry.changes).length > 0) item.changes = entry.changes;
        const trimmedNote = entry.note.trim();
        if (trimmedNote.length > 0) item.note = trimmedNote;
        return item;
      });

  const makeSessionId = (archivedAt: string): string =>
    `${archivedAt}-${Math.random().toString(36).slice(2, 8)}`;

  const areEntriesEqual = (a: UiTextEditEntry<Lang> | undefined, b: UiTextEditEntry<Lang> | undefined): boolean => {
    if (!a || !b) return a === b;
    if (a.note.trim() !== b.note.trim()) return false;
    for (const lang of languages) {
      const ca = a.changes[lang];
      const cb = b.changes[lang];
      if ((ca === undefined) !== (cb === undefined)) return false;
      if (ca && cb && (ca.before !== cb.before || ca.after !== cb.after)) return false;
    }
    return true;
  };

  const areEntrySetsEqual = (
    a: Record<string, UiTextEditEntry<Lang>>,
    b: Record<string, UiTextEditEntry<Lang>>,
  ): boolean => {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(key => areEntriesEqual(a[key], b[key]));
  };

  const cloneEntriesMap = (entries: Record<string, UiTextEditEntry<Lang>>): Record<string, UiTextEditEntry<Lang>> => {
    const out: Record<string, UiTextEditEntry<Lang>> = {};
    for (const [key, entry] of Object.entries(entries)) {
      const changes: Partial<Record<Lang, LanguageChange>> = {};
      for (const lang of languages) {
        const ch = entry.changes[lang];
        if (ch) changes[lang] = { before: ch.before, after: ch.after };
      }
      out[key] = { ...entry, changes };
    }
    return out;
  };

  const buildHistorySession = (
    entries: Record<string, UiTextEditEntry<Lang>>,
    archivedAt: string,
  ): UiTextHistorySession<Lang> | null => {
    const list = Object.values(entries).sort((a, b) => a.key.localeCompare(b.key));
    if (list.length === 0) return null;
    return { id: makeSessionId(archivedAt), archivedAt, entries: list };
  };

  let initPromise: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  let state: UiTextEditorState<Lang> = {
    initialized: false,
    originals: emptyOriginals(),
    entries: {},
    history: [],
  };

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setState = (patch: Partial<UiTextEditorState<Lang>>) => {
    state = { ...state, ...patch };
    snapshot = { ...state, ...actions };
    emit();
  };

  const commit = (
    nextEntries: Record<string, UiTextEditEntry<Lang>>,
    nextHistory: UiTextHistorySession<Lang>[],
    touchedKeys: Iterable<string>,
  ): boolean => {
    const persisted = writeStoredState({ entries: nextEntries, history: nextHistory });
    syncKeysToAdapter(touchedKeys, state.originals, nextEntries, nextHistory);
    setState({ entries: nextEntries, history: nextHistory });
    return persisted;
  };

  const actions: UiTextEditorActions<Lang> = {
    ensureInitialized: async () => {
      if (state.initialized) return;
      if (initPromise) return await initPromise;

      initPromise = (async () => {
        const loaded = await Promise.all(
          languages.map(async language => [language, await loadLanguageCatalog(language)] as const),
        );
        const originals = emptyOriginals();
        for (const [language, leaves] of loaded) {
          originals[language] = leaves;
        }

        const persisted = readStoredState();
        const touchedKeys = new Set<string>();
        for (const session of persisted.history) {
          for (const entry of session.entries) touchedKeys.add(entry.key);
        }
        for (const key of Object.keys(persisted.entries)) touchedKeys.add(key);
        syncKeysToAdapter(touchedKeys, originals, persisted.entries, persisted.history);

        setState({
          initialized: true,
          originals,
          entries: persisted.entries,
          history: persisted.history,
        });
      })();

      try {
        await initPromise;
      } finally {
        initPromise = null;
      }
    },

    getOriginal: (language, key) => state.originals[language].get(key),

    getCurrent: (language, key) =>
      resolveEffectiveValue(language, key, state.originals, state.entries, state.history),

    saveEntry: ({ key, values, note }) => {
      if (!state.initialized) return false;
      const prev = state.entries[key];
      const nextChanges: Partial<Record<Lang, LanguageChange>> = {};

      for (const language of languages) {
        const original = state.originals[language].get(key);
        if (original === undefined) continue;
        const nextValue = values[language];
        if (nextValue === undefined) {
          if (prev?.changes[language]) nextChanges[language] = prev.changes[language];
          continue;
        }
        if (nextValue !== original) {
          nextChanges[language] = { before: original, after: nextValue };
        } else if (prev?.changes[language]?.after === original) {
          nextChanges[language] = prev.changes[language]!;
        }
      }

      const trimmedNote = note.trim();
      const nextEntries = { ...state.entries };
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

      return commit(nextEntries, state.history, [key]);
    },

    revertLanguage: (key, language) => {
      if (!state.initialized) return;
      const prev = state.entries[key];
      if (!prev) return;
      const nextChanges = { ...prev.changes };
      delete nextChanges[language];
      const nextEntries = { ...state.entries };
      if (Object.keys(nextChanges).length === 0 && prev.note.trim().length === 0) {
        delete nextEntries[key];
      } else {
        nextEntries[key] = { ...prev, changes: nextChanges, updatedAt: new Date().toISOString() };
      }
      commit(nextEntries, state.history, [key]);
    },

    revertEntry: key => {
      if (!state.initialized || !state.entries[key]) return;
      const nextEntries = { ...state.entries };
      delete nextEntries[key];
      commit(nextEntries, state.history, [key]);
    },

    clearActive: () => {
      if (!state.initialized) return;
      const touched = Object.keys(state.entries);
      if (touched.length === 0) return;
      commit({}, state.history, touched);
    },

    createExportSnapshot: () => {
      const snapshotEntries = cloneEntriesMap(state.entries);
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

    buildHistoryExportPayload: sessionId => {
      const session = state.history.find(item => item.id === sessionId);
      if (!session) return null;
      return {
        version: 1,
        exportedAt: session.archivedAt,
        entries: formatExportEntries(session.entries),
      };
    },

    commitExportSnapshot: exportSnapshot => {
      if (!state.initialized) return null;
      const session = buildHistorySession(exportSnapshot.entries, exportSnapshot.payload.exportedAt);
      if (!session) return null;

      // Only clear entries that have not been modified since the snapshot was taken.
      const nextEntries = { ...state.entries };
      const touchedKeys = new Set<string>();
      for (const [key, snapEntry] of Object.entries(exportSnapshot.entries)) {
        if (areEntriesEqual(nextEntries[key], snapEntry)) {
          delete nextEntries[key];
          touchedKeys.add(key);
        }
      }

      const { kept: nextHistory, evictedKeys } = capHistory([session, ...state.history]);
      for (const key of evictedKeys) touchedKeys.add(key);
      commit(nextEntries, nextHistory, touchedKeys);
      return session;
    },

    restoreHistorySession: sessionId => {
      if (!state.initialized) return;
      const target = state.history.find(item => item.id === sessionId);
      if (!target) return;

      const now = new Date().toISOString();
      const archivedCurrent = buildHistorySession(state.entries, now);
      const remaining = state.history.filter(item => item.id !== sessionId);
      const { kept: nextHistory, evictedKeys } = capHistory(
        archivedCurrent ? [archivedCurrent, ...remaining] : remaining,
      );

      const nextEntries: Record<string, UiTextEditEntry<Lang>> = {};
      const touchedKeys = new Set<string>([...Object.keys(state.entries), ...evictedKeys]);
      for (const item of target.entries) {
        nextEntries[item.key] = { ...item };
        touchedKeys.add(item.key);
      }

      commit(nextEntries, nextHistory, touchedKeys);
    },

    deleteHistorySession: sessionId => {
      if (!state.initialized) return;
      const session = state.history.find(item => item.id === sessionId);
      if (!session) return;
      const nextHistory = state.history.filter(item => item.id !== sessionId);
      commit(state.entries, nextHistory, session.entries.map(item => item.key));
    },

    clearHistory: () => {
      if (!state.initialized || state.history.length === 0) return;
      const touchedKeys = new Set<string>();
      for (const session of state.history) {
        for (const item of session.entries) touchedKeys.add(item.key);
      }
      commit(state.entries, [], touchedKeys);
    },

    importFromJson: rawJson => {
      if (!state.initialized) {
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

      const importedEntries: Record<string, UiTextEditEntry<Lang>> = {};
      let imported = 0;
      const now = new Date().toISOString();

      for (const item of rawItems) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        if (typeof rec.key !== 'string' || rec.key.trim().length === 0) continue;
        const key = rec.key.trim();
        const note = typeof rec.note === 'string' ? rec.note : '';
        const changes: Partial<Record<Lang, LanguageChange>> = {};

        if (rec.changes && typeof rec.changes === 'object' && !Array.isArray(rec.changes)) {
          for (const [lang, rawChange] of Object.entries(rec.changes as Record<string, unknown>)) {
            if (!isSupportedLanguage(lang) || !rawChange || typeof rawChange !== 'object' || Array.isArray(rawChange)) continue;
            const ch = rawChange as Record<string, unknown>;
            if (typeof ch.before !== 'string' || typeof ch.after !== 'string') continue;
            changes[lang] = { before: ch.before, after: ch.after };
          }
        }

        if (Object.keys(changes).length === 0 && note.trim().length === 0) continue;

        importedEntries[key] = { key, changes, note, updatedAt: now };
        imported += 1;
      }

      // No-op when nothing was parsed or when the imported set is identical to
      // the active session so repeated pastes never duplicate history entries.
      if (imported === 0 || areEntrySetsEqual(state.entries, importedEntries)) {
        return { imported, changed: false };
      }

      const archivedCurrent = buildHistorySession(state.entries, now);
      const { kept: nextHistory, evictedKeys } = capHistory(
        archivedCurrent ? [archivedCurrent, ...state.history] : state.history,
      );

      const touchedKeys = new Set<string>([
        ...Object.keys(state.entries),
        ...Object.keys(importedEntries),
        ...evictedKeys,
      ]);
      commit(importedEntries, nextHistory, touchedKeys);
      return { imported, changed: true };
    },
  };

  let snapshot: UiTextEditorSnapshot<Lang> = { ...state, ...actions };

  return {
    storageKey,
    getState: () => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset(): void {
      initPromise = null;
      setState({
        initialized: false,
        originals: emptyOriginals(),
        entries: {},
        history: [],
      });
    },
  };
};
