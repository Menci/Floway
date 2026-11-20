import { useSyncExternalStore } from 'react';

import { ensureLocaleLoaded, i18n } from '../index';
import { languageNames, supportedLanguages, type SupportedLanguage } from '../languages';
import { numberFormats } from '../number-format';
import { loadLocale } from '../resources';
import {
  createUiTextEditorEngine,
  flattenCatalogLeaves,
  type UiTextEditEntry as GenericUiTextEditEntry,
  type UiTextEditorSnapshot,
} from './core/engine';

export type UiTextEditEntry = GenericUiTextEditEntry<SupportedLanguage>;

export const LANGUAGE_LABELS = languageNames;

export const SHORT_LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  'en': 'EN',
  'zh-Hans': '中文',
};

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

// `number-format.ts` throws at render for unknown formats or numeric
// interpolations that drop their format. Edits remain saveable and exportable,
// while candidates that drop an existing format or name an unknown format are
// excluded from live i18next projection.
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

const engine = createUiTextEditorEngine<SupportedLanguage>({
  languages: supportedLanguages,
  storageKey: 'floway.uiTextEditorState.v1',
  maxHistorySessions: 200,
  loadLanguageCatalog: async language => {
    const resource = await loadLocale(language);
    const translation = resource.translation;
    if (typeof translation !== 'object' || translation === null) {
      throw new TypeError(`Locale "${language}" is missing a translation catalog object.`);
    }
    // Boot may contain only shell strings; load the full i18next bundle before
    // applying and previewing edits in each locale.
    await ensureLocaleLoaded(language);
    return flattenCatalogLeaves(translation);
  },
  applyResourceValue: (language, key, value) => {
    i18n.addResource(language, 'translation', key, value);
  },
  isSafeForLiveProjection,
});

type FlowayUiTextEditorSnapshot = UiTextEditorSnapshot<SupportedLanguage>;

const useStoreHook = <T>(selector: (state: FlowayUiTextEditorSnapshot) => T): T =>
  useSyncExternalStore(
    engine.subscribe,
    () => selector(engine.getState()),
    () => selector(engine.getState()),
  );

export const useUiTextEditorStore = Object.assign(useStoreHook, {
  getState: engine.getState,
});

export const __testing = {
  storageKey: engine.storageKey,
  reset: engine.reset,
};
