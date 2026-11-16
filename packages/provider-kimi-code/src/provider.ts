import { assertKimiCodeUpstreamRecord } from './config.ts';
import { KIMI_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { kimiCodeFetch } from './fetch.ts';
import { fetchKimiCodeModels } from './models.ts';
import { scheduleKimiCodeProbes, runKimiCodeScheduledTask } from './probe.ts';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { headersForAnthropicMessagesCall, jsonRequestBody, resolveEffectiveFlags, streamingProviderCall, type HttpHeaderLines, type Provider, type ProviderInstance, type ProviderModel, type ProviderStreamParser, type UpstreamCallOptions, type UpstreamRecord } from '@floway-dev/provider';

export const createKimiCodeProvider = (record: UpstreamRecord): Provider => {
  const { config } = assertKimiCodeUpstreamRecord(record);
  const enabledFlags = resolveEffectiveFlags([KIMI_CODE_DEFAULT_FLAGS, record.flagOverrides]);

  // Forward thinking and effort unchanged. Some models advertise thinking-only
  // yet accept disabled thinking; the service's own rejection is authoritative.
  // https://www.kimi.com/code/docs/en/kimi-code/models.html
  const call = async (path: string, model: ProviderModel, body: Record<string, unknown>, signal: AbortSignal | undefined, headers: HttpHeaderLines, opts: UpstreamCallOptions, probes: boolean) => {
    const response = await kimiCodeFetch(config, path,
      { method: 'POST', body: jsonRequestBody({ ...body, model: model.upstreamModelId }), signal },
      { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall });
    // Quota exhaustion (429) and plan restrictions (403) warrant a current read.
    // https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
    if (probes) scheduleKimiCodeProbes(record, config, opts.fetcher, opts.waitUntil, response.status === 429 || response.status === 403);
    return response;
  };

  const streaming = <T>(path: string, model: ProviderModel, body: Record<string, unknown>, signal: AbortSignal | undefined, headers: HttpHeaderLines, parser: ProviderStreamParser<T>, opts: UpstreamCallOptions) =>
    streamingProviderCall(call(path, model, { ...body, stream: true }, signal, headers, opts, true), parser, model.upstreamModelId, signal);

  const unsupported = (method: string) => () => Promise.reject(new Error(`Kimi Code provider does not implement ${method}`));

  // Fixed coding-service endpoints; the catalog contains conversational models,
  // so unrelated Open Platform capabilities are not inferred from model names.
  // https://www.kimi.com/code/docs/en/kimi-code/models.html
  const instance: ProviderInstance = {
    getProvidedModels: fetcher => fetchKimiCodeModels(config, fetcher, enabledFlags),
    runScheduledTask: options => runKimiCodeScheduledTask(record, options),
    callOpenAIChatCompletions: (model, body, signal, opts) => streaming('/chat/completions', model, body, signal, [...opts.headers], parseOpenAIChatCompletionsStream, opts),
    callOpenAIResponses: async (model, body, action, signal, opts) => {
      if (action === 'compact') throw new Error('Kimi Code does not expose a native Responses compaction endpoint');
      const result = await streaming('/responses', model, body, signal, [...opts.headers], parseOpenAIResponsesStream, opts);
      return { ...result, action: 'generate' };
    },
    callAnthropicMessages: (model, body, signal, opts) => streaming('/messages', model, body, signal, headersForAnthropicMessagesCall([...opts.headers], opts.anthropicBeta), parseAnthropicMessagesStream, opts),
    callAnthropicMessagesCountTokens: async (model, body, signal, opts) => ({
      response: await call('/messages/count_tokens', model, body, signal, headersForAnthropicMessagesCall([...opts.headers], opts.anthropicBeta), opts, false),
      modelKey: model.upstreamModelId,
    }),
    callAlphaSearch: unsupported('callAlphaSearch'),
    callOpenAICompletions: unsupported('callOpenAICompletions'),
    callOpenAIEmbeddings: unsupported('callOpenAIEmbeddings'),
    callOpenAIImagesGenerations: unsupported('callOpenAIImagesGenerations'),
    callOpenAIImagesEdits: unsupported('callOpenAIImagesEdits'),
    callOpenAIAudioTranscriptions: unsupported('callOpenAIAudioTranscriptions'),
    callRerank: unsupported('callRerank'),
    callDecision: unsupported('callDecision'),
  };
  return {
    upstreamId: record.id,
    kind: 'kimi-code',
    name: record.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    instance,
  };
};
