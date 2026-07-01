// Generic custom upstream — any third-party LLM provider that speaks an
// OpenAI-shaped or Anthropic-shaped HTTP API under a single base URL with a
// static credential. `authStyle` decides the credential header:
//   - 'bearer'    -> Authorization: Bearer <key>     (OpenAI, OpenRouter, ...)
//   - 'anthropic' -> x-api-key: <key> + anthropic-version: 2023-06-01
//                                                    (api.anthropic.com)
//   - 'none'      -> no auth header (local or internal upstreams that
//                                                    accept anonymous requests)
//
// The base URL is stored without an API prefix (admin enters e.g.
// https://api.openai.com); we join it to a per-endpoint path. Default paths
// follow `/v1/*`, but admins can override individual endpoints to handle
// providers that mount the API under a subpath while still serving e.g.
// `/models` at the root.
//
// Custom upstreams surface models from two sources, merged at the data
// plane: a statically configured list of per-model overrides
// (`config.models`) that pin metadata/pricing locally, and an optional
// live fetch of the upstream `/models` (`config.modelsFetch`). The `/models`
// path is part of the fetch toggle (`modelsFetch.endpoint`), not a generic
// path override, because it only matters when fetching is enabled.

import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { endpointsField, modelsField, validateUpstreamPath } from '@floway-dev/provider';

export type CustomAuthStyle = 'bearer' | 'anthropic' | 'none';

// Logical endpoints the admin may override. Sub-paths (the messages
// count-tokens endpoint, the responses compact endpoint) and the catalog
// (`/models` — owned by modelsFetch.endpoint) are intentionally absent:
// they derive their URL from a parent override or a separate field. Each
// key is the OpenAI-canonical path fragment so the default upstream path
// is just `/v1` + the key — the lookup table is the key itself. Kept
// package-internal because outside callers reach the upstream through
// the typed `customFetchXxx` transports, not by naming an endpoint key.
type CustomPathOverrideKey =
  | '/completions'
  | '/chat/completions'
  | '/responses'
  | '/messages'
  | '/embeddings'
  | '/images/generations'
  | '/images/edits';

export interface CustomModelsFetch {
  enabled: boolean;
  endpoint?: string;
}

// Fields shared by every auth style. The discriminated branches below add
// `apiKey` only on the styles that actually send one, so consumers cannot
// reach for `config.apiKey` on a 'none' upstream.
interface CustomUpstreamConfigBase {
  baseUrl: string;
  endpoints: ModelEndpoints;
  pathOverrides?: Partial<Record<CustomPathOverrideKey, string>>;
  modelsFetch: CustomModelsFetch;
  models: UpstreamModelConfig[];
}

export type CustomUpstreamConfig =
  | (CustomUpstreamConfigBase & { authStyle: 'none' })
  | (CustomUpstreamConfigBase & { authStyle: 'bearer' | 'anthropic'; apiKey: string });

export type CustomUpstreamRecord = UpstreamRecord & {
  kind: 'custom';
  config: CustomUpstreamConfig;
};

const AUTH_STYLES: ReadonlySet<CustomAuthStyle> = new Set<CustomAuthStyle>(['bearer', 'anthropic', 'none']);

const authStyleField = (value: unknown): CustomAuthStyle => {
  if (typeof value !== 'string' || !AUTH_STYLES.has(value as CustomAuthStyle)) {
    throw new Error('Malformed custom upstream config: authStyle must be "bearer", "anthropic", or "none"');
  }
  return value as CustomAuthStyle;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyStringField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Malformed custom upstream config: ${field} must be a non-empty string`);
  return value;
};

const baseUrlField = (value: unknown): string => {
  const baseUrl = nonEmptyStringField(value, 'baseUrl').trim();
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
  } catch {
    throw new Error('Malformed custom upstream config: baseUrl must be an http(s) URL');
  }
  return baseUrl;
};

const PATH_OVERRIDE_KEYS = new Set<CustomPathOverrideKey>([
  '/completions',
  '/chat/completions',
  '/responses',
  '/messages',
  '/embeddings',
  '/images/generations',
  '/images/edits',
]);

const pathOverridesField = (value: unknown): CustomUpstreamConfigBase['pathOverrides'] => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Malformed custom upstream config: pathOverrides must be an object');

  const pathOverrides: NonNullable<CustomUpstreamConfigBase['pathOverrides']> = {};
  for (const [key, path] of Object.entries(value)) {
    if (!PATH_OVERRIDE_KEYS.has(key as CustomPathOverrideKey)) {
      throw new Error(`Malformed custom upstream config: unsupported pathOverrides key ${key}`);
    }
    const validPath = validateUpstreamPath(path, `pathOverrides.${key}`);
    if (!validPath.ok) throw new Error(`Malformed custom upstream config: ${validPath.error}`);
    pathOverrides[key as CustomPathOverrideKey] = validPath.value;
  }
  return pathOverrides;
};

// The /models fetch toggle. Absent defaults to enabled: existing upstreams
// fetched their model list before this toggle existed, and the migration
// backfills `{ enabled: true }`. `endpoint` is the optional `/models` path
// override; the migration writes `endpoint: null` where there was no
// override, so null/empty must parse cleanly as "no override".
const modelsFetchField = (value: unknown): CustomModelsFetch => {
  if (value === undefined) return { enabled: true };
  if (!isRecord(value)) throw new Error('Malformed custom upstream config: modelsFetch must be an object');
  if (typeof value.enabled !== 'boolean') throw new Error('Malformed custom upstream config: modelsFetch.enabled must be a boolean');

  if (value.endpoint === undefined || value.endpoint === null || value.endpoint === '') {
    return { enabled: value.enabled };
  }
  const validPath = validateUpstreamPath(value.endpoint, 'modelsFetch.endpoint');
  if (!validPath.ok) throw new Error(`Malformed custom upstream config: ${validPath.error}`);
  return { enabled: value.enabled, endpoint: validPath.value };
};

export const assertCustomUpstreamRecord = (record: UpstreamRecord): CustomUpstreamRecord => {
  if (record.kind !== 'custom') throw new Error(`Expected custom upstream record, got ${record.kind}`);
  if (!isRecord(record.config)) throw new Error('Malformed custom upstream config: config must be an object');

  const raw = record.config;
  const authStyle = authStyleField(raw.authStyle);
  const base = {
    baseUrl: baseUrlField(raw.baseUrl),
    endpoints: endpointsField(raw.endpoints, 'custom upstream config: endpoints', { allowEmpty: true }),
    ...(raw.pathOverrides !== undefined ? { pathOverrides: pathOverridesField(raw.pathOverrides) } : {}),
    modelsFetch: modelsFetchField(raw.modelsFetch),
    models: modelsField(raw.models ?? [], 'custom'),
  };

  if (authStyle === 'none') {
    // Reject dead fields: a stored 'none' row must not carry a stale apiKey
    // from an earlier auth style. mergeConfigPatch enforces this on PATCH
    // and the migration leaves no such rows, so any presence here signals
    // bad input.
    if (raw.apiKey !== undefined) {
      throw new Error('Malformed custom upstream config: apiKey must not be present when authStyle is "none"');
    }
    return { ...record, kind: 'custom', config: { ...base, authStyle } };
  }

  const apiKey = nonEmptyStringField(raw.apiKey, 'apiKey');
  return { ...record, kind: 'custom', config: { ...base, authStyle, apiKey } };
};
