// Configurable custom upstream — any third-party provider that serves one or
// more supported generation, embedding, image, or rerank protocols under a
// single base URL with a static credential. `authStyle` decides the credential header:
//   - 'bearer'    -> Authorization: Bearer <key>     (OpenAI, OpenRouter, ...)
//   - 'anthropic' -> x-api-key: <key> + anthropic-version: 2023-06-01
//                                                    (api.anthropic.com)
//   - 'none'      -> no auth header (local or internal upstreams that
//                                                    accept anonymous requests)
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

import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { endpointsField, modelsField, validateUpstreamPath } from '@floway-dev/provider';

export type CustomAuthStyle = 'bearer' | 'anthropic' | 'none';

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
  '/embeddings',
  '/alpha/search',
  '/images/generations',
  '/images/edits',
  '/audio/transcriptions',
] as const;

export type CustomPathOverrideKey = typeof CUSTOM_PATH_OVERRIDE_KEYS[number];

export interface CustomModelsFetch {
  enabled: boolean;
  endpoint?: string;
}

export interface CustomIngressHeaderRule {
  key: string;
  value: string | null;
}

// Fields shared by every auth style. The discriminated branches below add
// `apiKey` only on the styles that actually send one, so consumers cannot
// reach for `config.apiKey` on a 'none' upstream.
interface CustomUpstreamConfigBase {
  baseUrl: string;
  endpoints: ModelEndpoints;
  pathOverrides?: Partial<Record<CustomPathOverrideKey, string>>;
  ingressHeadersRules: CustomIngressHeaderRule[];
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

// https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.2
export const CUSTOM_INBOUND_HEADER_ALLOWLIST = [/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/] as const;
const HTTP_FIELD_NAME_PATTERN = CUSTOM_INBOUND_HEADER_ALLOWLIST[0];

// Field values admit HTAB, visible ASCII, and obs-text bytes. Fetch rejects
// every other control byte and values that cannot undergo ByteString
// conversion, so persisted replacements are validated before request time.
// https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5
const isHttpFieldValue = (value: string): boolean => [...value].every(char => {
  const code = char.charCodeAt(0);
  return code === 0x09 || (code >= 0x20 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
});

// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/beta.ts#L622-L635
const PROTOCOL_OWNED_INGRESS_HEADER_NAMES = new Map([
  ['anthropic-beta', 'Messages'],
]);

// These names belong to the gateway/provider transport boundary, not the
// upstream application protocol. Forwarding body metadata after Floway has
// reserialized JSON/FormData misframes the new body; forwarding gateway auth,
// cookies, proxy/IP signals, or hop-by-hop fields leaks credentials/topology or
// is rejected by runtime fetch.
// https://www.rfc-editor.org/rfc/rfc9110.html#section-7.6.1
// https://www.rfc-editor.org/rfc/rfc9110.html#section-11.7
// https://www.rfc-editor.org/rfc/rfc7239.html
// https://www.rfc-editor.org/rfc/rfc8586.html
// https://www.rfc-editor.org/rfc/rfc6455.html#section-11.3
// https://developers.cloudflare.com/fundamentals/reference/http-request-headers/
// https://cloud.google.com/apis/docs/system-parameters
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/model-provider-info/src/lib.rs#L396-L408
const PROTECTED_INGRESS_HEADER_NAMES = new Set([
  'accept-encoding',
  'authorization',
  'cdn-loop',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'cookie',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-authentication-info',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'true-client-ip',
  'upgrade',
  'x-api-key',
  'x-client-ip',
  'x-floway-session',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-goog-api-key',
  'x-openai-actor-authorization',
  'x-real-ip',
]);

const PROTECTED_INGRESS_HEADER_PREFIXES = [
  'cf-',
  'sec-websocket-',
  'x-forwarded-',
] as const;

const ingressHeadersRulesField = (value: unknown): CustomIngressHeaderRule[] => {
  if (!Array.isArray(value)) throw new Error('Malformed custom upstream config: ingressHeadersRules must be an array');
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!isRecord(raw) || Object.keys(raw).some(key => key !== 'key' && key !== 'value')) {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}] must contain only key and value`);
    }
    if (typeof raw.key !== 'string' || !HTTP_FIELD_NAME_PATTERN.test(raw.key.trim())) {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].key must be a valid HTTP header name`);
    }
    const key = raw.key.trim().toLowerCase();
    const owningProtocol = PROTOCOL_OWNED_INGRESS_HEADER_NAMES.get(key);
    if (owningProtocol !== undefined) {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].key ${key} is owned by the ${owningProtocol} protocol`);
    }
    if (PROTECTED_INGRESS_HEADER_NAMES.has(key) || PROTECTED_INGRESS_HEADER_PREFIXES.some(prefix => key.startsWith(prefix))) {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].key ${key} is owned by the HTTP transport`);
    }
    if (seen.has(key)) {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules contains duplicate key ${key}`);
    }
    seen.add(key);
    if (raw.value !== null && typeof raw.value !== 'string') {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].value must be a string or null`);
    }
    if (raw.value === null) return { key, value: null };
    if (!isHttpFieldValue(raw.value)) {
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

const PATH_OVERRIDE_KEYS: ReadonlySet<string> = new Set(CUSTOM_PATH_OVERRIDE_KEYS);

const pathOverridesField = (value: unknown): CustomUpstreamConfigBase['pathOverrides'] => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Malformed custom upstream config: pathOverrides must be an object');

  const pathOverrides: NonNullable<CustomUpstreamConfigBase['pathOverrides']> = {};
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
    ingressHeadersRules: ingressHeadersRulesField(raw.ingressHeadersRules),
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
