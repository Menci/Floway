import { nonEmptyStringField } from '@floway-dev/provider';

const AZURE_ENDPOINT_HOST_SUFFIXES = ['.openai.azure.com', '.services.ai.azure.com'];

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

export const azureEndpointField = (value: unknown, label: string): string => {
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

export const azureOpenAiV1BaseUrl = (endpoint: string): string => {
  const url = new URL(trimTrailingSlash(endpoint));
  const path = trimTrailingSlash(url.pathname);
  if (path.endsWith('/openai/v1')) {
    url.pathname = path;
  } else if (isFoundryProjectRootPath(path)) {
    url.pathname = `${path}/openai/v1`;
  } else {
    url.pathname = '/openai/v1';
  }
  return trimTrailingSlash(url.href);
};

export const azureAnthropicBaseUrl = (endpoint: string): string => {
  const url = new URL(trimTrailingSlash(endpoint));
  if (url.hostname.endsWith('.openai.azure.com')) {
    url.hostname = `${url.hostname.slice(0, -'.openai.azure.com'.length)}.services.ai.azure.com`;
  }
  // The Anthropic surface is resource-scoped, so every admitted endpoint shape —
  // resource root, Foundry project root, an /openai/v1 URL, or an /anthropic*
  // URL — resolves to the same `/anthropic` base.
  url.pathname = '/anthropic';
  return trimTrailingSlash(url.href);
};
