import type { ModelEndpoints, UpstreamModelConfig } from '../../api/types.ts';

export const PATH_KEYS = ['chat_completions', 'responses', 'messages', 'completions', 'embeddings', 'images_generations', 'images_edits'] as const;
export type PathKey = typeof PATH_KEYS[number];

export const emptyPathOverrides = (): Record<PathKey, string> => ({
  chat_completions: '',
  responses: '',
  messages: '',
  completions: '',
  embeddings: '',
  images_generations: '',
  images_edits: '',
});

export const seedPathOverrides = (saved: Record<string, string> | null | undefined): Record<PathKey, string> => {
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
// across the SecretInput and lets the user toggle between styles without
// the field disappearing from the underlying object. buildCustomConfigCore
// projects this onto the discriminated wire shape: it omits apiKey entirely
// when 'none', and otherwise sends a trimmed key (or omits it for the
// edit-mode "keep stored secret" path).
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
export type CustomConfigCore =
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
