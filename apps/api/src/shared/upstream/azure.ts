import { joinBaseAndPath } from './join.ts';
import type { EndpointKey, Upstream, UpstreamFetchOptions } from './types.ts';
import { isKnownFlagId } from '../../data-plane/providers/flags.ts';
import type { UpstreamRecord } from '../../repo/types.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';

export interface AzureDeploymentConfig {
  deployment: string;
  publicModelId?: string;
  supportedEndpoints: string[];
  display_name?: string;
  limits?: AzureDeploymentLimits;
  cost?: ModelPricing;
  flagOverrides?: AzureDeploymentFlagOverrides;
}

export interface AzureDeploymentFlagOverrides {
  enabled: boolean;
  values: Record<string, boolean>;
}

export interface AzureDeploymentLimits {
  max_context_window_tokens?: number;
  max_prompt_tokens?: number;
  max_output_tokens?: number;
}

export interface AzureUpstreamConfig {
  endpoint: string;
  apiKey: string;
  deployments: AzureDeploymentConfig[];
}

type AzureUpstreamRecord = UpstreamRecord & {
  provider: 'azure';
  config: AzureUpstreamConfig;
};

const AZURE_OPENAI_PATHS: Partial<Record<EndpointKey, string>> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  embeddings: '/embeddings',
  models: '/models',
  images_generations: '/images/generations',
  images_edits: '/images/edits',
};

// Per-endpoint query suffix appended to the resolved request URL. Image
// endpoints on Azure's /openai/v1 surface currently require
// ?api-version=preview because gpt-image-2 (released 2026-04-21) and the
// gpt-image-1 family are exposed only under the preview lifecycle. We will
// drop this entry once Azure promotes the image endpoints to the GA default.
const AZURE_OPENAI_QUERY: Partial<Record<EndpointKey, string>> = {
  images_generations: 'api-version=preview',
  images_edits: 'api-version=preview',
};

const AZURE_ANTHROPIC_PATHS: Partial<Record<EndpointKey, string>> = {
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
};

const OPENAI_DEPLOYMENT_ENDPOINT_PATHS = new Set([
  '/chat/completions', '/v1/chat/completions',
  '/responses', '/v1/responses',
  '/embeddings', '/v1/embeddings',
  '/images/generations', '/v1/images/generations',
  '/images/edits', '/v1/images/edits',
]);
const ANTHROPIC_DEPLOYMENT_ENDPOINT_PATHS = new Set(['/v1/messages', '/messages']);
const SUPPORTED_ENDPOINT_PATHS = new Set([...OPENAI_DEPLOYMENT_ENDPOINT_PATHS, ...ANTHROPIC_DEPLOYMENT_ENDPOINT_PATHS]);
const AZURE_ENDPOINT_HOST_SUFFIXES = ['.openai.azure.com', '.services.ai.azure.com'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyStringField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Malformed azure upstream config: ${field} must be a non-empty string`);
  return value;
};

const optionalStringField = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Malformed azure upstream config: ${field} must be a string`);
  return value;
};

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const isFoundryProjectRootPath = (path: string): boolean => /^\/api\/projects\/[^/]+$/.test(path);

const isAnthropicBasePath = (path: string): boolean => path === '/anthropic' || path === '/anthropic/v1' || path === '/anthropic/v1/messages';

const isAzureEndpointHost = (hostname: string): boolean =>
  AZURE_ENDPOINT_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix) && hostname.length > suffix.length);

const optionalHttpUrlField = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  const url = trimTrailingSlash(nonEmptyStringField(value, field).trim());
  if (url.includes('?') || url.includes('#')) {
    throw new Error(`Malformed azure upstream config: ${field} must be an http(s) URL without query or fragment`);
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
    if (parsed.search || parsed.hash) {
      throw new Error('query or fragment');
    }
  } catch {
    throw new Error(`Malformed azure upstream config: ${field} must be an http(s) URL without query or fragment`);
  }
  return url;
};

const azureEndpointField = (value: unknown, field: string): string => {
  const url = optionalHttpUrlField(value, field);
  if (!url) throw new Error(`Malformed azure upstream config: ${field} is required`);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !isAzureEndpointHost(parsed.hostname)) {
    throw new Error(`Malformed azure upstream config: ${field} must be an https Azure URL on *.openai.azure.com or *.services.ai.azure.com`);
  }

  const path = trimTrailingSlash(parsed.pathname);
  if (path !== '' && !isFoundryProjectRootPath(path) && !path.endsWith('/openai/v1') && !isAnthropicBasePath(path)) {
    throw new Error(`Malformed azure upstream config: ${field} must be an Azure resource root, a Foundry project endpoint, an OpenAI v1 URL ending in /openai/v1, an /anthropic URL, an /anthropic/v1 URL, or an /anthropic/v1/messages URL`);
  }
  return url;
};

const supportedEndpointsField = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Malformed azure upstream config: ${field} must be a non-empty string array`);
  }

  const endpoints: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`Malformed azure upstream config: ${field} must be a non-empty string array`);
    if (!SUPPORTED_ENDPOINT_PATHS.has(item)) {
      throw new Error(`Malformed azure upstream config: unsupported supportedEndpoints entry ${item}`);
    }
    if (!endpoints.includes(item)) endpoints.push(item);
  }
  return endpoints;
};

const optionalNumberField = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Malformed azure upstream config: ${field} must be a finite number`);
  return value;
};

const optionalMetadataRecord = (value: unknown, field: string): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Malformed azure upstream config: ${field} must be an object`);
  return value;
};

const limitsField = (value: unknown, field: string): AzureDeploymentLimits | undefined => {
  const record = optionalMetadataRecord(value, field);
  if (!record) return undefined;
  return {
    ...(record.max_context_window_tokens !== undefined ? { max_context_window_tokens: optionalNumberField(record.max_context_window_tokens, `${field}.max_context_window_tokens`) } : {}),
    ...(record.max_prompt_tokens !== undefined ? { max_prompt_tokens: optionalNumberField(record.max_prompt_tokens, `${field}.max_prompt_tokens`) } : {}),
    ...(record.max_output_tokens !== undefined ? { max_output_tokens: optionalNumberField(record.max_output_tokens, `${field}.max_output_tokens`) } : {}),
  };
};

const flagOverridesField = (value: unknown, field: string): AzureDeploymentFlagOverrides | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Malformed azure upstream config: ${field} must be an object`);
  if (typeof value.enabled !== 'boolean') throw new Error(`Malformed azure upstream config: ${field}.enabled must be a boolean`);
  if (!isRecord(value.values)) throw new Error(`Malformed azure upstream config: ${field}.values must be an object`);
  const unknown: string[] = [];
  const values: Record<string, boolean> = {};
  for (const [id, on] of Object.entries(value.values)) {
    if (typeof on !== 'boolean') throw new Error(`Malformed azure upstream config: ${field}.values.${id} must be a boolean`);
    if (!isKnownFlagId(id)) {
      unknown.push(id);
      continue;
    }
    values[id] = on;
  }
  if (unknown.length > 0) {
    throw new Error(`Malformed azure upstream config: ${field}.values has unknown flag ids: ${unknown.join(', ')}`);
  }
  return { enabled: value.enabled, values };
};

const nonNegativeNumberField = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Malformed azure upstream config: ${field} must be a finite non-negative number`);
  }
  return value;
};

const pricingField = (value: unknown, field: string): ModelPricing | undefined => {
  const record = optionalMetadataRecord(value, field);
  if (!record) return undefined;
  if (record.input === undefined && record.output === undefined && record.cache_read === undefined && record.cache_write === undefined) {
    return undefined;
  }
  if (record.input === undefined || record.output === undefined) {
    throw new Error(`Malformed azure upstream config: ${field}.input and ${field}.output must both be set when ${field} is provided`);
  }
  const pricing: ModelPricing = {
    input: nonNegativeNumberField(record.input, `${field}.input`),
    output: nonNegativeNumberField(record.output, `${field}.output`),
  };
  if (record.cache_read !== undefined) pricing.cache_read = nonNegativeNumberField(record.cache_read, `${field}.cache_read`);
  if (record.cache_write !== undefined) pricing.cache_write = nonNegativeNumberField(record.cache_write, `${field}.cache_write`);
  return pricing;
};

const deploymentField = (value: unknown, index: number): AzureDeploymentConfig => {
  if (!isRecord(value)) throw new Error(`Malformed azure upstream config: deployments[${index}] must be an object`);
  const pricing = pricingField(value.cost, `deployments[${index}].cost`);
  return {
    deployment: nonEmptyStringField(value.deployment, `deployments[${index}].deployment`),
    ...(value.publicModelId !== undefined ? { publicModelId: optionalStringField(value.publicModelId, `deployments[${index}].publicModelId`) } : {}),
    supportedEndpoints: supportedEndpointsField(value.supportedEndpoints, `deployments[${index}].supportedEndpoints`),
    ...(value.display_name !== undefined ? { display_name: optionalStringField(value.display_name, `deployments[${index}].display_name`) } : {}),
    ...(value.limits !== undefined ? { limits: limitsField(value.limits, `deployments[${index}].limits`) } : {}),
    ...(pricing ? { cost: pricing } : {}),
    ...(value.flagOverrides !== undefined ? { flagOverrides: flagOverridesField(value.flagOverrides, `deployments[${index}].flagOverrides`) } : {}),
  };
};

const deploymentsField = (value: unknown): AzureDeploymentConfig[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Malformed azure upstream config: deployments must be a non-empty array');
  }
  return value.map(deploymentField);
};

const deploymentsUseAnyEndpoint = (deployments: readonly AzureDeploymentConfig[], endpoints: ReadonlySet<string>): boolean =>
  deployments.some(deployment => deployment.supportedEndpoints.some(endpoint => endpoints.has(endpoint)));

const validateEndpointCoverage = (config: AzureUpstreamConfig): void => {
  const usesOpenAi = deploymentsUseAnyEndpoint(config.deployments, OPENAI_DEPLOYMENT_ENDPOINT_PATHS);
  const usesAnthropic = deploymentsUseAnyEndpoint(config.deployments, ANTHROPIC_DEPLOYMENT_ENDPOINT_PATHS);

  if (!usesOpenAi && !usesAnthropic) {
    throw new Error('Malformed azure upstream config: deployments must declare at least one OpenAI v1 or Anthropic endpoint');
  }
};

export const assertAzureUpstreamRecord = (record: UpstreamRecord): AzureUpstreamRecord => {
  if (record.provider !== 'azure') throw new Error(`Expected azure upstream record, got ${record.provider}`);
  if (!isRecord(record.config)) throw new Error('Malformed azure upstream config: config must be an object');

  const config: AzureUpstreamConfig = {
    endpoint: azureEndpointField(record.config.endpoint, 'endpoint'),
    apiKey: nonEmptyStringField(record.config.apiKey, 'apiKey'),
    deployments: deploymentsField(record.config.deployments),
  };
  validateEndpointCoverage(config);

  return {
    ...record,
    provider: 'azure',
    config,
  };
};

const configuredSupportedEndpoints = (config: AzureUpstreamConfig): string[] => {
  const endpoints: string[] = [];
  for (const deployment of config.deployments) {
    for (const endpoint of deployment.supportedEndpoints) {
      if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
    }
  }
  return endpoints;
};

const azureOpenAiV1BaseUrl = (endpoint: string): string => {
  const url = new URL(trimTrailingSlash(endpoint));
  const path = trimTrailingSlash(url.pathname);
  if (path.endsWith('/openai/v1')) {
    url.pathname = path;
  } else if (path === '/anthropic/v1/messages' || path === '/anthropic/v1' || path === '/anthropic') {
    url.pathname = '/openai/v1';
  } else if (isFoundryProjectRootPath(path)) {
    url.pathname = `${path}/openai/v1`;
  } else {
    url.pathname = '/openai/v1';
  }
  return trimTrailingSlash(url.href);
};

const withAzureFoundryServicesHost = (url: URL): URL => {
  const next = new URL(url.href);
  if (next.hostname.endsWith('.openai.azure.com')) {
    next.hostname = `${next.hostname.slice(0, -'.openai.azure.com'.length)}.services.ai.azure.com`;
  }
  return next;
};

const azureAnthropicBaseUrl = (endpoint: string): string => {
  const url = withAzureFoundryServicesHost(new URL(trimTrailingSlash(endpoint)));
  const path = trimTrailingSlash(url.pathname);
  if (path === '/anthropic/v1/messages') {
    url.pathname = path.slice(0, -'/v1/messages'.length);
  } else if (path === '/anthropic/v1') {
    url.pathname = path.slice(0, -3);
  } else if (path === '/anthropic') {
    url.pathname = path;
  } else {
    url.pathname = '/anthropic';
  }
  return trimTrailingSlash(url.href);
};

const requestUrl = (openAiBaseUrl: string | undefined, anthropicBaseUrl: string | undefined, endpoint: EndpointKey): string => {
  const openAiPath = AZURE_OPENAI_PATHS[endpoint];
  if (openAiPath) {
    if (!openAiBaseUrl) throw new Error('Azure upstream config does not include an OpenAI v1 endpoint');
    const url = joinBaseAndPath(openAiBaseUrl, openAiPath);
    const query = AZURE_OPENAI_QUERY[endpoint];
    if (!query) return url;
    // Append per-endpoint query through URL.searchParams so a future path
    // that itself carries a query suffix does not produce `path?a?b`.
    // AZURE_OPENAI_QUERY stores already-encoded pairs (e.g. `api-version=
    // preview`); parsing-then-appending preserves their encoding.
    const parsed = new URL(url);
    for (const [key, value] of new URLSearchParams(query).entries()) {
      parsed.searchParams.append(key, value);
    }
    return parsed.href;
  }

  const anthropicPath = AZURE_ANTHROPIC_PATHS[endpoint];
  if (anthropicPath) {
    if (!anthropicBaseUrl) throw new Error('Azure upstream config does not include an Anthropic endpoint');
    return joinBaseAndPath(anthropicBaseUrl, anthropicPath);
  }

  throw new Error(`Unsupported Azure upstream endpoint ${endpoint}`);
};

const isAnthropicEndpoint = (endpoint: EndpointKey): boolean => endpoint === 'messages' || endpoint === 'messages_count_tokens';

export const createAzureUpstream = (record: UpstreamRecord): Upstream => {
  const { config } = assertAzureUpstreamRecord(record);
  const openAiBaseUrl = azureOpenAiV1BaseUrl(config.endpoint);
  const anthropicBaseUrl = azureAnthropicBaseUrl(config.endpoint);
  return {
    id: record.id,
    name: record.name,
    kind: 'azure',
    supportedEndpoints: configuredSupportedEndpoints(config),
    fetch: async (endpoint, init: RequestInit, options?: UpstreamFetchOptions) => {
      const headers = new Headers(init.headers);
      if (isAnthropicEndpoint(endpoint)) {
        headers.set('x-api-key', config.apiKey);
        headers.set('anthropic-version', '2023-06-01');
      } else {
        headers.set('api-key', config.apiKey);
      }
      if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
        headers.set('Content-Type', 'application/json');
      }
      if (options?.extraHeaders) {
        for (const [key, value] of Object.entries(options.extraHeaders)) {
          headers.set(key, value);
        }
      }
      return await fetch(requestUrl(openAiBaseUrl, anthropicBaseUrl, endpoint), { ...init, headers });
    },
  };
};
