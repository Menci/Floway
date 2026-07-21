import type { ModelEndpoints } from '@floway-dev/protocols/common';
import { type UpstreamModelConfig, type UpstreamRecord, isRecord, modelsField, nonEmptyStringField } from '@floway-dev/provider';

export interface AzureUpstreamConfig {
  endpoint: string;
  apiKey: string;
  models: UpstreamModelConfig[];
}

export type AzureUpstreamRecord = UpstreamRecord & {
  kind: 'azure';
  config: AzureUpstreamConfig;
};

const AZURE_ENDPOINT_HOST_SUFFIXES = ['.openai.azure.com', '.services.ai.azure.com'];

// Path-shape predicates shared by validation (here) and URL resolution
// (./fetch.ts). Exported so the fetch layer recognises the same endpoint
// shapes the validator admits.
export const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');
export const isFoundryProjectRootPath = (path: string): boolean => /^\/api\/projects\/[^/]+$/.test(path);
const isAnthropicBasePath = (path: string): boolean => path === '/anthropic' || path === '/anthropic/v1' || path === '/anthropic/v1/messages';
const isAzureEndpointHost = (hostname: string): boolean =>
  AZURE_ENDPOINT_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix) && hostname.length > suffix.length);

// All azure-local field validators take the same fully-qualified label
// (`azure upstream config: <field>`) the shared model-config helpers expect,
// so every message reads `Malformed azure upstream config: <field>: <reason>`.
const optionalHttpUrlField = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  const url = trimTrailingSlash(nonEmptyStringField(value, label).trim());
  if (url.includes('?') || url.includes('#')) {
    throw new Error(`Malformed ${label}: must be an http(s) URL without query or fragment`);
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
    throw new Error(`Malformed ${label}: must be an http(s) URL without query or fragment`);
  }
  return url;
};

const azureEndpointField = (value: unknown, label: string): string => {
  const url = optionalHttpUrlField(value, label);
  if (!url) throw new Error(`Malformed ${label}: is required`);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !isAzureEndpointHost(parsed.hostname)) {
    throw new Error(`Malformed ${label}: must be an https Azure URL on *.openai.azure.com or *.services.ai.azure.com`);
  }

  const path = trimTrailingSlash(parsed.pathname);
  if (path !== '' && !isFoundryProjectRootPath(path) && !path.endsWith('/openai/v1') && !isAnthropicBasePath(path)) {
    throw new Error(`Malformed ${label}: must be an Azure resource root, a Foundry project endpoint, an OpenAI v1 URL ending in /openai/v1, an /anthropic URL, an /anthropic/v1 URL, or an /anthropic/v1/messages URL`);
  }
  return url;
};

export const assertAzureUpstreamRecord = (record: UpstreamRecord): AzureUpstreamRecord => {
  if (record.kind !== 'azure') throw new Error(`Expected azure upstream record, got ${record.kind}`);
  if (!isRecord(record.config)) throw new Error('Malformed azure upstream config: config must be an object');

  const models = modelsField(record.config.models, 'azure');
  if (models.length === 0) throw new Error('Malformed azure upstream config: models must be a non-empty array');
  if (models.some(model => model.kind === 'rerank')) {
    throw new Error('Malformed azure upstream config: rerank models require a custom upstream');
  }

  const config: AzureUpstreamConfig = {
    endpoint: azureEndpointField(record.config.endpoint, 'azure upstream config: endpoint'),
    apiKey: nonEmptyStringField(record.config.apiKey, 'azure upstream config: apiKey'),
    models,
  };

  return {
    ...record,
    kind: 'azure',
    config,
  };
};

// The union of every model's declared endpoints. Azure always carries explicit
// per-model endpoints, so this upstream-level map is informational only (the
// per-model fallback never fires); sub-capabilities are dropped since only
// presence matters here.
export const configuredEndpoints = (config: AzureUpstreamConfig): ModelEndpoints =>
  config.models.reduce<ModelEndpoints>((acc, model) => ({ ...acc, ...model.endpoints }), {});
