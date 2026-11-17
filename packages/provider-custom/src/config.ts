// Configurable custom upstream — any third-party provider that serves one or
// more supported generation, embedding, image, or rerank protocols under a
// single base URL with a static credential. The outbound protocol chooses the
// credential header: OpenAI-compatible calls use
// `Authorization: Bearer <key>`, Anthropic Messages calls use
// `x-api-key: <key>` plus `anthropic-version`, and Gemini generateContent calls
// use `x-goog-api-key`. An empty key sends no credential and lets local or
// internal upstreams accept anonymous requests.
//
// The base URL is stored without an API prefix and joined to the selected
// protocol's path. Generation-family path overrides remain upstream-wide;
// rerank chooses its dialect and optional path on each model because no
// vendor-neutral rerank path exists.
//
// Custom upstreams surface models from two sources, merged at the data
// plane: a manual list of per-model entries
// (`config.models`) that pin metadata/pricing locally, and an optional
// live fetch of the upstream `/models` (`config.modelsFetch`). The `/models`
// path is part of the fetch toggle (`modelsFetch.endpoint`), not a generic
// path override, because it only matters when fetching is enabled.

import { customIngressHeaderNameIssue, isCustomIngressHeaderValue } from './ingress-header-rules.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { endpointsField, modelsField, validateUpstreamPath } from '@floway-dev/provider';

// Logical endpoints the admin may override. Sub-paths (the messages
// count-tokens endpoint, the responses compact endpoint) and the catalog
// (`/models` — owned by modelsFetch.endpoint) are intentionally absent:
// they derive their URL from a parent override or a separate field. Each
// key is the default path fragment, so the upstream path is `/v1` + the key
// unless overridden — the lookup table is the key itself. Kept
// package-internal because outside callers reach the upstream through
// the typed `customFetchXxx` transports, not by naming an endpoint key.
const CUSTOM_PATH_OVERRIDE_KEYS = [
  '/completions',
  '/chat/completions',
  '/responses',
  '/messages',
  '/v1beta/models',
  '/embeddings',
  '/alpha/search',
  '/images/generations',
  '/images/edits',
  '/audio/transcriptions',
] as const;

export type CustomPathOverrideKey = typeof CUSTOM_PATH_OVERRIDE_KEYS[number];

export type CustomAuthStyle = 'bearer' | 'x-api-key' | 'x-goog-api-key';

export interface CustomModelsFetch {
  enabled: boolean;
  authStyle: CustomAuthStyle;
  endpoint?: string;
}

// One rule per value the operator wants this upstream to receive under a
// header name. `value: null` passes the client's own value through, so it
// contributes a value only when the client sent the header. Any other value —
// the empty string included — is this upstream's own value and is contributed
// on every request.
//
// A name may carry several rules, and the upstream receives their values in
// rule order: a passthrough rule beside a configured one appends the
// configured value to what the client sent, and several configured rules send
// several values. A name carries at most one passthrough rule, because the
// client's values enter the request once. A name with no rule at all reaches
// no upstream: it is not admitted, and nothing here writes it.
//
// How several values reach the wire is the runtime's choice, and the two
// disagree: workerd keeps them as a list and emits one field line each, while
// undici concatenates on append and emits a single combined line. RFC 9110
// makes those the same field value for a list-typed name, so rules are
// expressed as values and the representation is left to the runtime.
// https://github.com/cloudflare/workerd/blob/5165b467ef2a5df54768cb5f18f33b2916e58fa7/src/workerd/api/headers.c%2B%2B#L398-L440
// https://github.com/nodejs/undici/blob/v8.3.0/lib/web/fetch/headers.js#L236-L258
// https://www.rfc-editor.org/rfc/rfc9110.html#section-5.3
export interface CustomIngressHeaderRule {
  key: string;
  value: string | null;
}

export interface CustomUpstreamConfig {
  apiKey: string;
  baseUrl: string;
  endpoints: ModelEndpoints;
  pathOverrides?: Partial<Record<CustomPathOverrideKey, string>>;
  ingressHeadersRules: CustomIngressHeaderRule[];
  modelsFetch: CustomModelsFetch;
  models: UpstreamModelConfig[];
}

export type CustomUpstreamRecord = UpstreamRecord & {
  kind: 'custom';
  config: CustomUpstreamConfig;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const ingressHeadersRulesField = (value: unknown): CustomIngressHeaderRule[] => {
  if (!Array.isArray(value)) throw new Error('Malformed custom upstream config: ingressHeadersRules must be an array');
  const passthroughKeys = new Set<string>();
  return value.map((raw, index) => {
    if (!isRecord(raw) || Object.keys(raw).some(key => key !== 'key' && key !== 'value')) {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}] must contain only key and value`);
    }
    if (typeof raw.key !== 'string') {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].key must be a valid HTTP header name`);
    }
    const key = raw.key.trim().toLowerCase();
    const nameIssue = customIngressHeaderNameIssue(key);
    if (nameIssue === 'invalid') {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].key must be a valid HTTP header name`);
    }
    if (nameIssue === 'anthropic-messages-owned') {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].key ${key} is owned by the Anthropic Messages protocol`);
    }
    if (nameIssue === 'transport-owned') {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].key ${key} is owned by the HTTP transport`);
    }
    if (raw.value !== null && typeof raw.value !== 'string') {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].value must be a string or null`);
    }
    if (raw.value === null) {
      if (passthroughKeys.has(key)) {
        throw new Error(`Malformed custom upstream config: ingressHeadersRules passes ${key} through more than once`);
      }
      passthroughKeys.add(key);
      return { key, value: null };
    }
    if (!isCustomIngressHeaderValue(raw.value)) {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].value is not a valid HTTP header value`);
    }
    const headers = new Headers();
    headers.set(key, raw.value);
    return { key, value: headers.get(key) as string };
  });
};

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

const apiKeyField = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Malformed custom upstream config: apiKey must be a string');
  return value.trim();
};

const PATH_OVERRIDE_KEYS: ReadonlySet<string> = new Set(CUSTOM_PATH_OVERRIDE_KEYS);

const pathOverridesField = (value: unknown): CustomUpstreamConfig['pathOverrides'] => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Malformed custom upstream config: pathOverrides must be an object');

  const pathOverrides: NonNullable<CustomUpstreamConfig['pathOverrides']> = {};
  for (const [key, path] of Object.entries(value)) {
    if (!PATH_OVERRIDE_KEYS.has(key)) {
      throw new Error(`Malformed custom upstream config: unsupported pathOverrides key ${key}`);
    }
    const validPath = validateUpstreamPath(path, `pathOverrides.${key}`);
    if (!validPath.ok) throw new Error(`Malformed custom upstream config: ${validPath.error}`);
    pathOverrides[key as CustomPathOverrideKey] = validPath.value;
  }
  return pathOverrides;
};

const CUSTOM_AUTH_STYLES: ReadonlySet<CustomAuthStyle> = new Set<CustomAuthStyle>(['bearer', 'x-api-key', 'x-goog-api-key']);

const customAuthStyleField = (value: unknown): CustomAuthStyle => {
  if (typeof value !== 'string' || !CUSTOM_AUTH_STYLES.has(value as CustomAuthStyle)) {
    throw new Error('Malformed custom upstream config: modelsFetch.authStyle must be "bearer", "x-api-key", or "x-goog-api-key"');
  }
  return value as CustomAuthStyle;
};

// The /models fetch toggle. The catalog endpoint has no request protocol to
// infer from, so it carries its own authentication scheme: the header name the
// upstream expects (`bearer` means an Authorization header). Absent defaults to
// enabled bearer fetches for configs that predate the toggle. `endpoint` is
// the optional `/models` path override; null/empty parse as "no override".
const modelsFetchField = (value: unknown): CustomModelsFetch => {
  if (value === undefined) return { enabled: true, authStyle: 'bearer' };
  if (!isRecord(value)) throw new Error('Malformed custom upstream config: modelsFetch must be an object');
  if (typeof value.enabled !== 'boolean') throw new Error('Malformed custom upstream config: modelsFetch.enabled must be a boolean');
  const authStyle = customAuthStyleField(value.authStyle);

  if (value.endpoint === undefined || value.endpoint === null || value.endpoint === '') {
    return { enabled: value.enabled, authStyle };
  }
  const validPath = validateUpstreamPath(value.endpoint, 'modelsFetch.endpoint');
  if (!validPath.ok) throw new Error(`Malformed custom upstream config: ${validPath.error}`);
  return { enabled: value.enabled, authStyle, endpoint: validPath.value };
};

export const assertCustomUpstreamRecord = (record: UpstreamRecord): CustomUpstreamRecord => {
  if (record.kind !== 'custom') throw new Error(`Expected custom upstream record, got ${record.kind}`);
  if (!isRecord(record.config)) throw new Error('Malformed custom upstream config: config must be an object');

  const raw = record.config;
  const base = {
    apiKey: apiKeyField(raw.apiKey),
    baseUrl: baseUrlField(raw.baseUrl),
    endpoints: endpointsField(raw.endpoints, 'custom upstream config: endpoints', { allowEmpty: true }),
    ...(raw.pathOverrides !== undefined ? { pathOverrides: pathOverridesField(raw.pathOverrides) } : {}),
    ingressHeadersRules: ingressHeadersRulesField(raw.ingressHeadersRules),
    modelsFetch: modelsFetchField(raw.modelsFetch),
    models: modelsField(raw.models ?? [], 'custom'),
  };

  return { ...record, kind: 'custom', config: base };
};
