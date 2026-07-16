import type { ModelEndpoints, UpstreamModelConfig, UpstreamRecord } from '../../api/types.ts';

export const PATH_KEYS = [
  '/completions',
  '/chat/completions',
  '/responses',
  '/messages',
  '/embeddings',
  '/alpha/search',
  '/images/generations',
  '/images/edits',
] as const;
export type PathKey = typeof PATH_KEYS[number];

export const emptyPathOverrides = (): Record<PathKey, string> => ({
  '/completions': '',
  '/chat/completions': '',
  '/responses': '',
  '/messages': '',
  '/embeddings': '',
  '/alpha/search': '',
  '/images/generations': '',
  '/images/edits': '',
});

export const seedPathOverrides = (saved: Record<string, string> | undefined): Record<PathKey, string> => {
  const out = emptyPathOverrides();
  if (!saved) return out;
  for (const k of PATH_KEYS) {
    const v = saved[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
};

export type CustomAuthStyle = 'bearer' | 'anthropic' | 'none';

// Form state is kept flat (apiKey is always a string slot, even when
// authStyle === 'none' parks it as ''). This keeps two-way binding simple
// across the SecretInput and lets the operator toggle between styles
// without the field disappearing from the underlying object.
// buildCustomConfigCore projects this onto the discriminated wire shape: it
// omits apiKey entirely when 'none', and otherwise sends a trimmed key (or
// omits it for the edit-mode "keep stored secret" path).
export interface CustomDraft {
  baseUrl: string;
  authStyle: CustomAuthStyle;
  endpoints: ModelEndpoints;
  apiKey: string;
  pathOverrides: Record<PathKey, string>;
  // Live /models browse toggle and its endpoint override; an empty endpoint
  // means "use the OpenAI default", stripped to undefined on save.
  modelsFetch: { enabled: boolean; endpoint: string };
  // Manual (overridden) model entries only — auto rows are resolved live and
  // never persisted.
  models: UpstreamModelConfig[];
}

export interface AzureDraft {
  endpoint: string;
  apiKey: string;
  models: UpstreamModelConfig[];
}

export interface OllamaDraft {
  baseUrl: string;
  apiKey: string;
  models: UpstreamModelConfig[];
}

interface CustomConfigCoreBase {
  baseUrl: string;
  endpoints: ModelEndpoints;
  modelsFetch: { enabled: boolean; endpoint?: string };
}

// Wire-shape projection of CustomDraft. Discriminated on authStyle so the
// 'none' branch can't carry an apiKey field at all.
type CustomConfigCore =
  | (CustomConfigCoreBase & { authStyle: 'none' })
  | (CustomConfigCoreBase & { authStyle: 'bearer' | 'anthropic'; apiKey?: string });

// The fields shared by the persisted config and the /models browse preview.
// Keeping a single builder guarantees the browse request can never drift from
// what save() would write. For non-'none' styles, an empty apiKey is omitted
// so the backend keeps the stored secret; for 'none', apiKey is dropped
// entirely.
export const buildCustomConfigCore = (draft: CustomDraft): CustomConfigCore => {
  const base: CustomConfigCoreBase = {
    baseUrl: draft.baseUrl.trim(),
    endpoints: draft.endpoints,
    modelsFetch: {
      enabled: draft.modelsFetch.enabled,
      ...(draft.modelsFetch.endpoint.trim() ? { endpoint: draft.modelsFetch.endpoint.trim() } : {}),
    },
  };
  if (draft.authStyle === 'none') return { ...base, authStyle: 'none' };

  const trimmed = draft.apiKey.trim();
  return trimmed
    ? { ...base, authStyle: draft.authStyle, apiKey: trimmed }
    : { ...base, authStyle: draft.authStyle };
};

export const blankCustomDraft = (): CustomDraft => ({
  baseUrl: '',
  authStyle: 'bearer',
  endpoints: { chatCompletions: {} },
  apiKey: '',
  pathOverrides: emptyPathOverrides(),
  modelsFetch: { enabled: true, endpoint: '' },
  models: [],
});

export const blankAzureDraft = (): AzureDraft => ({
  endpoint: '',
  apiKey: '',
  models: [{ upstreamModelId: '', kind: 'chat', endpoints: { responses: {} } }],
});

// Ollama's catalog is always live-fetched (/api/tags + /api/show), so the
// draft has no manual-by-default rows — operators add overrides explicitly
// when they want to pin metadata or pricing.
export const blankOllamaDraft = (): OllamaDraft => ({
  baseUrl: 'https://ollama.com',
  apiKey: '',
  models: [],
});

// Wire-shape projection of OllamaDraft. Shared by save() and the list-models
// preview so the two paths cannot drift.
export const buildOllamaConfig = (draft: OllamaDraft): Record<string, unknown> => {
  const config: Record<string, unknown> = {
    baseUrl: draft.baseUrl.trim(),
    models: draft.models,
  };
  if (draft.apiKey.trim()) config.apiKey = draft.apiKey.trim();
  return config;
};

// Wire-shape projection of AzureDraft. Azure has no list-models path (the
// catalog is operator-authored), so this only feeds save().
export const buildAzureConfig = (draft: AzureDraft): Record<string, unknown> => {
  const config: Record<string, unknown> = {
    endpoint: draft.endpoint.trim(),
    models: draft.models,
  };
  if (draft.apiKey.trim()) config.apiKey = draft.apiKey.trim();
  return config;
};

// Wire-shape projection for POST /api/upstreams/list-models. Consolidates the
// per-kind builder dispatch and the edit-mode stored-secret fallback so the
// preview probes the same shape save() would write. Matches save()'s
// backend-patch-omit semantics — an untyped apiKey in edit mode falls back to
// the record's stored secret so the preview does not hit an unauthenticated
// upstream when the operator merely tweaks non-credential fields.
export const buildListModelsPreviewConfig = (
  record: UpstreamRecord,
  customDraft: CustomDraft,
  ollamaDraft: OllamaDraft,
  isCreate: boolean,
): Record<string, unknown> => {
  const config: Record<string, unknown> = record.kind === 'custom'
    ? { ...buildCustomConfigCore(customDraft), models: customDraft.models }
    : buildOllamaConfig(ollamaDraft);
  if (!isCreate && config.apiKey === undefined) {
    if (record.kind === 'custom' && record.config.authStyle !== 'none' && record.config.apiKey) {
      config.apiKey = record.config.apiKey;
    } else if (record.kind === 'ollama' && record.config.apiKey) {
      config.apiKey = record.config.apiKey;
    }
  }
  return config;
};
