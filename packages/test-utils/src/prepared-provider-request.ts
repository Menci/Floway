import { collectHttpPipeline } from './http-pipeline.ts';
import { stubProviderModel } from './stubs.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose, type Stage } from '@floway-dev/pipeline';
import { observeProviderCall, providerModelFacts, type FetchInit, type ProviderOperation, type ProviderRequest, type ProviderResponse, type UpstreamFetchOptions } from '@floway-dev/provider';

export const collectPreparedProviderRequest = async (prepare: Stage, operation: ProviderOperation, modelData: (modelKey: string) => unknown, init: FetchInit, options: UpstreamFetchOptions, selectedModel?: string): Promise<Response> => {
  const fields: Record<string, unknown> = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
  const modelKey = selectedModel ?? (typeof fields.model === 'string' ? fields.model : 'test-model');
  const { model: _, ...json } = fields;
  let payload: object = json;
  if (init.body instanceof FormData) {
    const entries = await Promise.all([...init.body].map(async ([name, value]) => ({ name, value: typeof value === 'string' ? value : { name: value.name, type: value.type, lastModified: value.lastModified, bytes: new Uint8Array(await value.arrayBuffer()) } })));
    payload = { entries };
  }
  const headers = [...new Headers(init.headers), ...options.extraHeaders ?? []].map(([name, value]): [string, string] => [name, value]);
  const beta = new Headers(headers).get('anthropic-beta');
  const pipeline = compose<ProviderRequest<object>, ProviderResponse>('testPreparedProviderRequest', [prepare, observeProviderCall, http]);
  const result = await collectHttpPipeline(pipeline, {
    'request.provider.model': providerModelFacts(stubProviderModel({ id: modelKey, providerData: modelData(modelKey) })),
    'request.provider.payload': payload,
    'request.http.callId': 0,
    'request.http.headers': headers,
    ...(operation === 'openaiResponses' || operation === 'openaiResponsesCompact' ? { 'request.provider.responsesAction': operation === 'openaiResponsesCompact' ? 'compact' : 'generate' } : {}),
    ...(operation === 'anthropicMessages' || operation === 'anthropicMessagesCountTokens' ? { 'request.provider.anthropicBeta': beta === null ? [] : beta.split(',') } : {}),
  }, { httpCall: () => ({ ...options, signal: init.signal ?? undefined, waitUntil: () => {} }) });
  return result.response;
};
