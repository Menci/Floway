import type { ModelEndpointKey, ModelEndpoints, ModelKind, UpstreamModelConfig } from '../../api/types.ts';

export type Row =
  | { uiId: string; kind: 'manual'; config: UpstreamModelConfig }
  | { uiId: string; kind: 'auto'; auto: UpstreamModelConfig };

let nextUiId = 0;
export const newUiId = () => `m${++nextUiId}`;

export const configOf = (row: Row): UpstreamModelConfig =>
  row.kind === 'manual' ? row.config : row.auto;

const CHAT_ENDPOINT_KEYS: ModelEndpointKey[] = ['completions', 'chatCompletions', 'responses', 'messages'];
const IMAGE_ENDPOINT_KEYS: ModelEndpointKey[] = ['imagesGenerations', 'imagesEdits'];

// The endpoint map to apply when switching INTO a kind, preserving any current
// endpoints (and their sub-capabilities) that already belong to that kind so a
// chat model keeps its protocol choices across an accidental round-trip.
export const defaultEndpointsForKind = (kind: ModelKind, current: ModelEndpoints | undefined): ModelEndpoints => {
  if (kind === 'embedding') return { embeddings: {} };
  const keys = kind === 'image' ? IMAGE_ENDPOINT_KEYS : CHAT_ENDPOINT_KEYS;
  const kept: ModelEndpoints = {};
  for (const key of keys) if (current?.[key]) kept[key] = current[key]!;
  if (Object.keys(kept).length > 0) return kept;
  return kind === 'image' ? { imagesGenerations: {}, imagesEdits: {} } : { chatCompletions: {} };
};

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
    ...(auto.cost ? { cost: { ...auto.cost } } : {}),
  };
};

// The public catalog id a row is exposed (and disabled) under: an explicit
// publicModelId override when set, otherwise the upstream id. Mirrors the
// backend publicModelId() so the toggle and the combobox key on the same id
// the data plane filters by.
export const publicIdOf = (row: Row): string => {
  const c = configOf(row);
  const configured = c.publicModelId?.trim();
  if (configured) return configured;
  return c.upstreamModelId;
};

export const titleFor = (row: Row): string => {
  const c = configOf(row);
  const display = c.display_name?.trim();
  if (display) return display;
  const upstream = c.upstreamModelId.trim();
  if (upstream) return upstream;
  return 'Untitled model';
};
