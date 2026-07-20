import type { ModelEndpointKey, ModelEndpoints, ModelKind, UpstreamModelConfig } from '../../api/types.ts';

// A row's `kind` names the source of its `config`, not the shape:
// `manual` came from `upstreams.config.models[]` (persists on PATCH,
// operator-editable); `auto` came from the live wire projection of
// `POST /api/upstreams/list-models` (read-only, never persists).
export interface Row {
  uiId: string;
  kind: 'manual' | 'auto';
  config: UpstreamModelConfig;
}

let nextUiId = 0;
export const newUiId = () => `m${++nextUiId}`;

const CHAT_ENDPOINT_KEYS: ModelEndpointKey[] = ['completions', 'chatCompletions', 'responses', 'messages'];
const IMAGE_ENDPOINT_KEYS: ModelEndpointKey[] = ['imagesGenerations', 'imagesEdits'];

// The endpoint map to apply when switching INTO a kind, preserving any current
// endpoints (and their sub-capabilities) that already belong to that kind so a
// chat model keeps its protocol choices across an accidental round-trip.
export const defaultEndpointsForKind = (kind: ModelKind, current: ModelEndpoints | undefined): ModelEndpoints => {
  if (kind === 'embedding') return { embeddings: {} };
  if (kind === 'rerank') return { rerank: {} };
  const keys = kind === 'image' ? IMAGE_ENDPOINT_KEYS : CHAT_ENDPOINT_KEYS;
  const kept: ModelEndpoints = {};
  for (const key of keys) if (current?.[key]) kept[key] = current[key]!;
  if (Object.keys(kept).length > 0) return kept;
  return kind === 'image' ? { imagesGenerations: {}, imagesEdits: {} } : { chatCompletions: {} };
};

// Crystallize an auto row's live projection into a manual row: copy every
// metadata field, and pull the auto row's `flagOverrides` (the provider's
// per-model rule) into the manual row's `flagOverrides` so the operator
// starts from the same layer-3 state the provider was applying.
export const seedFromAuto = (auto: UpstreamModelConfig): UpstreamModelConfig => {
  const kind = auto.kind;
  return {
    upstreamModelId: auto.upstreamModelId,
    kind,
    endpoints: Object.keys(auto.endpoints).length > 0
      ? { ...auto.endpoints }
      : defaultEndpointsForKind(kind, undefined),
    ...(auto.publicModelId ? { publicModelId: auto.publicModelId } : {}),
    ...(auto.display_name ? { display_name: auto.display_name } : {}),
    ...(auto.limits ? { limits: { ...auto.limits } } : {}),
    ...(auto.pricing ? { pricing: { ...auto.pricing } } : {}),
    ...(auto.chat ? { chat: auto.chat } : {}),
    ...(auto.flagOverrides ? { flagOverrides: { ...auto.flagOverrides } } : {}),
    ...(kind === 'rerank' ? { rerankTarget: auto.rerankTarget ?? { protocol: 'cohere-v2' } } : {}),
  };
};

// The public catalog id a row is exposed (and disabled) under: an explicit
// publicModelId override when set, otherwise the upstream id. Mirrors the
// backend publicModelId() so the toggle and the combobox key on the same id
// the data plane filters by.
export const publicIdOf = (row: Row): string => {
  const configured = row.config.publicModelId?.trim();
  if (configured) return configured;
  return row.config.upstreamModelId;
};

export const titleFor = (row: Row): string => {
  const display = row.config.display_name?.trim();
  if (display) return display;
  const upstream = row.config.upstreamModelId.trim();
  if (upstream) return upstream;
  return 'Untitled model';
};
