import type { AzureUpstreamConfig } from './config.ts';
import { azureAnthropicBaseUrl, azureOpenAiV1BaseUrl } from './endpoint.ts';
import { type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

const azureFetchUrl = async (
  config: AzureUpstreamConfig,
  surface: 'openai' | 'anthropic',
  url: string,
  init: RequestInit,
  options: UpstreamFetchOptions,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (surface === 'anthropic') {
    headers.set('x-api-key', config.apiKey);
    headers.set('anthropic-version', '2023-06-01');
  } else {
    headers.set('api-key', config.apiKey);
  }
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.extraHeaders) {
    for (const [key, value] of options.extraHeaders) headers.set(key, value);
  }
  return await options.wrapUpstreamCall(() => options.fetcher(url, { ...init, headers }));
};

const azureFetchInternal = async (
  config: AzureUpstreamConfig,
  surface: 'openai' | 'anthropic',
  path: string,
  init: RequestInit,
  options: UpstreamFetchOptions,
  query?: string,
): Promise<Response> => {
  const baseUrl = surface === 'openai' ? azureOpenAiV1BaseUrl(config.endpoint) : azureAnthropicBaseUrl(config.endpoint);
  const url = joinBaseAndPath(baseUrl, path);
  if (!query) {
    return await azureFetchUrl(config, surface, url, init, options);
  }
  // Append per-endpoint query through URL.searchParams so a future path
  // that itself carries a query suffix does not produce `path?a?b`.
  const parsed = new URL(url);
  for (const [key, value] of new URLSearchParams(query).entries()) parsed.searchParams.append(key, value);
  return await azureFetchUrl(config, surface, parsed.href, init, options);
};

const azureDeploymentScopedAudioTranscriptionUrl = (config: AzureUpstreamConfig, deployment: string): string => {
  const url = new URL(config.endpoint);
  url.pathname = `/openai/deployments/${encodeURIComponent(deployment)}/audio/transcriptions`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('api-version', '2025-04-01-preview');
  return url.href;
};

export const azureFetchChatCompletions = (config: AzureUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/chat/completions', init, options);
export const azureFetchResponses = (config: AzureUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/responses', init, options);
export const azureFetchResponsesCompact = (config: AzureUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/responses/compact', init, options);
export const azureFetchEmbeddings = (config: AzureUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/embeddings', init, options);
export const azureFetchCompletions = (config: AzureUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/completions', init, options);
// gpt-image-2 (released 2026-04-21) and the gpt-image-1 family are exposed
// only under Azure's preview lifecycle today. We will drop the query suffix
// once Azure promotes the image endpoints to the GA default.
export const azureFetchImagesGenerations = (config: AzureUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/images/generations', init, options, 'api-version=preview');
export const azureFetchImagesEdits = (config: AzureUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/images/edits', init, options, 'api-version=preview');
// Azure selects the transcription deployment in the operation path, so the
// multipart body must omit `model`. The 2025-04 preview route covers both
// Whisper and GPT transcription deployments; all configured endpoint shapes
// reduce to their resource host before this operation-specific path is set.
// https://github.com/Azure/azure-rest-api-specs/blob/b0a48bcbffead733affe03944ef09f5e8d12f8c8/specification/cognitiveservices/OpenAI.Inference/models/audio/audio_transcription.tsp#L119-L126
// https://github.com/Azure/azure-rest-api-specs/blob/928047803788f7377fa003a26ba2bdc2e0fcccc0/specification/cognitiveservices/OpenAI.Inference/routes/audio_transcription.tsp#L19-L49
export const azureFetchAudioTranscriptions = (config: AzureUpstreamConfig, deployment: string, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  azureFetchUrl(config, 'openai', azureDeploymentScopedAudioTranscriptionUrl(config, deployment), init, options);
export const azureFetchMessages = (config: AzureUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'anthropic', '/v1/messages', init, options);
export const azureFetchMessagesCountTokens = (config: AzureUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'anthropic', '/v1/messages/count_tokens', init, options);
