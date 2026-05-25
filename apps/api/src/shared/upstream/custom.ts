// Generic custom upstream — any third-party LLM provider that speaks an
// OpenAI-shaped or Anthropic-shaped HTTP API under a single base URL with a
// static credential. `authStyle` decides the credential header:
//   - 'bearer'    -> Authorization: Bearer <token>   (OpenAI, OpenRouter,
//                                                     floway, ...)
//   - 'anthropic' -> x-api-key: <token> + anthropic-version: 2023-06-01
//                                                    (api.anthropic.com)
//
// The base URL is stored without an API prefix (admin enters e.g.
// https://api.openai.com); we join it to a per-endpoint path. Default paths
// follow `/v1/*`, but admins can override individual endpoints to handle
// providers that mount the API under a subpath while still serving e.g.
// `/models` at the root.
//
// TODO: support admin-supplied per-model pricing overrides (similar to
// AzureDeploymentConfig.cost). Today, custom pricing is whatever the upstream
// `/models` response itself reports under a `cost` field.

import { joinBaseAndPath, validateUpstreamPath } from './join.ts';
import type { EndpointKey, Upstream, UpstreamFetchOptions } from './types.ts';
import type { UpstreamRecord } from '../../repo/types.ts';

export type CustomAuthStyle = 'bearer' | 'anthropic';

export interface CustomUpstreamConfig {
  baseUrl: string;
  bearerToken: string;
  authStyle: CustomAuthStyle;
  supportedEndpoints: string[];
  pathOverrides?: Partial<Record<Exclude<EndpointKey, 'messages_count_tokens'>, string>>;
}

const ANTHROPIC_VERSION = '2023-06-01';

const AUTH_STYLES: ReadonlySet<CustomAuthStyle> = new Set<CustomAuthStyle>(['bearer', 'anthropic']);

const authStyleField = (value: unknown): CustomAuthStyle => {
  // Records written before authStyle existed default to bearer, matching the
  // previous fixed behavior.
  if (value === undefined) return 'bearer';
  if (typeof value !== 'string' || !AUTH_STYLES.has(value as CustomAuthStyle)) {
    throw new Error('Malformed custom upstream config: authStyle must be "bearer" or "anthropic"');
  }
  return value as CustomAuthStyle;
};

type CustomUpstreamRecord = UpstreamRecord & {
  provider: 'custom';
  config: CustomUpstreamConfig;
};

const trimTrailingSlash = (s: string): string => s.replace(/\/+$/, '');

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

// supportedEndpoints declares which chat generation protocols this upstream
// speaks. Embeddings is implicit: a per-model `kind === 'embedding'`
// derivation (Tier 1: upstream /models published `kind`; Tier 2: id
// heuristic) decides per-model whether the embeddings endpoint is used, so
// `/embeddings` is intentionally NOT a valid entry here.
const SUPPORTED_ENDPOINT_PATHS = new Set(['/chat/completions', '/v1/chat/completions', '/responses', '/v1/responses', '/v1/messages', '/messages']);

const supportedEndpointsField = (value: unknown): string[] => {
  // Empty is allowed: an upstream that only serves embedding models
  // (`kind === 'embedding'`) or image models (`kind === 'image'`) has no
  // chat protocol to declare. supportedEndpoints stays an array contract
  // so the storage shape is uniform across upstreams.
  if (!Array.isArray(value)) {
    throw new Error('Malformed custom upstream config: supportedEndpoints must be a string array');
  }

  const endpoints: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('Malformed custom upstream config: supportedEndpoints must be a string array');
    if (!SUPPORTED_ENDPOINT_PATHS.has(item)) {
      throw new Error(`Malformed custom upstream config: unsupported supportedEndpoints entry ${item}`);
    }
    if (!endpoints.includes(item)) endpoints.push(item);
  }
  return endpoints;
};

const PATH_OVERRIDE_KEYS = new Set<Exclude<EndpointKey, 'messages_count_tokens'>>(['chat_completions', 'responses', 'messages', 'embeddings', 'images_generations', 'images_edits', 'models']);

const pathOverridesField = (value: unknown): CustomUpstreamConfig['pathOverrides'] => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Malformed custom upstream config: pathOverrides must be an object');

  const pathOverrides: NonNullable<CustomUpstreamConfig['pathOverrides']> = {};
  for (const [key, path] of Object.entries(value)) {
    if (!PATH_OVERRIDE_KEYS.has(key as Exclude<EndpointKey, 'messages_count_tokens'>)) {
      throw new Error(`Malformed custom upstream config: unsupported pathOverrides key ${key}`);
    }
    const validPath = validateUpstreamPath(path, `pathOverrides.${key}`);
    if (!validPath.ok) throw new Error(`Malformed custom upstream config: ${validPath.error}`);
    pathOverrides[key as Exclude<EndpointKey, 'messages_count_tokens'>] = validPath.value;
  }
  return pathOverrides;
};

export const assertCustomUpstreamRecord = (record: UpstreamRecord): CustomUpstreamRecord => {
  if (record.provider !== 'custom') throw new Error(`Expected custom upstream record, got ${record.provider}`);
  if (!isRecord(record.config)) throw new Error('Malformed custom upstream config: config must be an object');

  return {
    ...record,
    provider: 'custom',
    config: {
      baseUrl: baseUrlField(record.config.baseUrl),
      bearerToken: nonEmptyStringField(record.config.bearerToken, 'bearerToken'),
      authStyle: authStyleField(record.config.authStyle),
      supportedEndpoints: supportedEndpointsField(record.config.supportedEndpoints),
      ...(record.config.pathOverrides !== undefined ? { pathOverrides: pathOverridesField(record.config.pathOverrides) } : {}),
    },
  };
};

const CUSTOM_DEFAULT_PATHS: Record<EndpointKey, string> = {
  chat_completions: '/v1/chat/completions',
  responses: '/v1/responses',
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
  embeddings: '/v1/embeddings',
  images_generations: '/v1/images/generations',
  images_edits: '/v1/images/edits',
  models: '/v1/models',
};

const resolveCustomPath = (config: CustomUpstreamConfig, endpoint: EndpointKey): string => {
  // count_tokens is intentionally not independently overridable — it tracks
  // whatever path the admin chose for `messages` so the two stay in sync.
  if (endpoint === 'messages_count_tokens') {
    const messagesPath = config.pathOverrides?.messages ?? CUSTOM_DEFAULT_PATHS.messages;
    return `${messagesPath}/count_tokens`;
  }
  return config.pathOverrides?.[endpoint] ?? CUSTOM_DEFAULT_PATHS[endpoint];
};

export const createCustomUpstream = (record: UpstreamRecord): Upstream => {
  const { config } = assertCustomUpstreamRecord(record);
  const baseUrl = trimTrailingSlash(config.baseUrl);
  return {
    id: record.id,
    name: record.name,
    kind: 'custom',
    supportedEndpoints: config.supportedEndpoints,
    fetch: async (endpoint, init: RequestInit, options?: UpstreamFetchOptions) => {
      const headers = new Headers(init.headers);
      if (config.authStyle === 'anthropic') {
        headers.set('x-api-key', config.bearerToken);
        if (!headers.has('anthropic-version')) headers.set('anthropic-version', ANTHROPIC_VERSION);
      } else {
        headers.set('Authorization', `Bearer ${config.bearerToken}`);
      }
      if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
        headers.set('Content-Type', 'application/json');
      }
      if (options?.extraHeaders) {
        for (const [k, v] of Object.entries(options.extraHeaders)) {
          headers.set(k, v);
        }
      }
      const url = joinBaseAndPath(baseUrl, resolveCustomPath(config, endpoint));
      return await fetch(url, { ...init, headers });
    },
  };
};
