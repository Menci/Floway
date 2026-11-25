import { assertKimiCodeUpstreamRecord } from './config.ts';
import { kimiCodeFetch } from './fetch.ts';
import { selectKimiCodeModel } from './model-selection.ts';
import { getKimiCodeProvidedModels } from './models.ts';
import { scheduleKimiCodeProbes, runKimiCodeScheduledTask } from './probe.ts';
import { kimiCodeChatSpeedParser, kimiCodeMessagesSpeedParser, kimiCodeMessagesWireBody, kimiCodeResponsesSpeedParser } from './speed.ts';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER, isFastServiceTier } from '@floway-dev/protocols/common';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { headersForAnthropicMessagesCall, jsonRequestBody, streamingProviderCall, type HttpHeaderLines, type Provider, type ProviderInstance, type ProviderModel, type ProviderStreamParser, type UpstreamCallOptions, type UpstreamRecord } from '@floway-dev/provider';

const fastModeRequired = (model: ProviderModel, field: 'service_tier' | 'speed') => ({
  ok: false as const,
  http: Response.json({
    ...(field === 'speed' ? { type: 'error' } : {}),
    error: { type: 'invalid_request_error', message: `'${model.id}' is only available with fast mode selected; set \`${field}: "${field === 'speed' ? 'fast' : FAST_SERVICE_TIER}"\`.` },
  }, { status: 400 }),
  modelKey: model.upstreamModelId,
});

const selectMessagesModel = (model: ProviderModel, speed: unknown) => {
  // Anthropic generally rejects fast requests on unsupported models, with a
  // documented exception. We reject them here; OpenAI permits a standard-speed
  // response carrying the selected tier.
  // https://platform.claude.com/docs/en/build-with-claude/fast-mode
  // https://developers.openai.com/api/docs/guides/priority-processing
  const selection = selectKimiCodeModel(model, speed === 'fast');
  if (speed === 'fast' && selection?.lane !== 'fast') {
    return {
      ok: false as const,
      http: Response.json({ type: 'error', error: { type: 'invalid_request_error', message: `'${model.id}' does not support fast mode; omit \`speed\` or set \`speed: "standard"\`.` } }, { status: 400 }),
      modelKey: model.upstreamModelId,
    };
  }
  return selection ?? fastModeRequired(model, 'speed');
};

export const createKimiCodeProvider = (record: UpstreamRecord): Provider => {
  const { config } = assertKimiCodeUpstreamRecord(record);

  // Forward thinking and effort unchanged. Observed responses echo the id that
  // was requested, so neither this layer nor the caller can tell which model
  // actually served a request the service routed differently; the documented
  // disabled-thinking behaviour for K3 and K2.7 Code Highspeed makes that a real
  // possibility rather than a hypothetical. Model-scoped restrictions would
  // instead present a request-dependent upstream rule as a gateway limit.
  // https://www.kimi.com/code/docs/en/kimi-code/models.html
  const call = async (path: string, modelId: string, body: Record<string, unknown>, signal: AbortSignal | undefined, headers: HttpHeaderLines, opts: UpstreamCallOptions, probes: boolean) => {
    const response = await kimiCodeFetch(config, path,
      { method: 'POST', body: jsonRequestBody({ ...body, model: modelId }), signal },
      { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall });
    // Quota exhaustion (429) and plan restrictions (403) warrant a current read.
    // https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
    if (probes) scheduleKimiCodeProbes(record, config, opts.fetcher, opts.waitUntil, response.status === 429 || response.status === 403);
    return response;
  };

  const streaming = <T>(path: string, modelId: string, body: Record<string, unknown>, signal: AbortSignal | undefined, headers: HttpHeaderLines, parser: ProviderStreamParser<T>, opts: UpstreamCallOptions) =>
    streamingProviderCall(call(path, modelId, { ...body, stream: true }, signal, headers, opts, true), parser, modelId, signal);

  const unsupported = (method: string) => () => Promise.reject(new Error(`Kimi Code provider does not implement ${method}`));

  // Fixed coding-service endpoints; the catalog contains conversational models,
  // so unrelated Open Platform capabilities are not inferred from model names.
  // https://www.kimi.com/code/docs/en/kimi-code/models.html
  const instance: ProviderInstance = {
    getProvidedModels: fetcher => getKimiCodeProvidedModels(record, fetcher),
    runScheduledTask: options => runKimiCodeScheduledTask(record, options),
    callOpenAIChatCompletions: async (model, body, signal, opts) => {
      const fast = isFastServiceTier(body.service_tier);
      const selection = selectKimiCodeModel(model, fast);
      if (selection === undefined) return fastModeRequired(model, 'service_tier');
      const { modelId, lane } = selection;
      const tier = lane === 'fast' ? FAST_SERVICE_TIER : 'default';
      return await streaming('/chat/completions', modelId, fast ? { ...body, service_tier: tier } : body, signal, [...opts.headers], fast ? kimiCodeChatSpeedParser(tier) : parseOpenAIChatCompletionsStream, opts);
    },
    callOpenAIResponses: async (model, body, action, signal, opts) => {
      if (action === 'compact') throw new Error('Kimi Code does not expose a native Responses compaction endpoint');
      const fast = isFastServiceTier(body.service_tier);
      const selection = selectKimiCodeModel(model, fast);
      if (selection === undefined) return { ...fastModeRequired(model, 'service_tier'), action: 'generate' };
      const { modelId, lane } = selection;
      const tier = lane === 'fast' ? FAST_SERVICE_TIER : 'default';
      const result = await streaming('/responses', modelId, fast ? { ...body, service_tier: tier } : body, signal, [...opts.headers], fast ? kimiCodeResponsesSpeedParser(tier) : parseOpenAIResponsesStream, opts);
      return { ...result, action: 'generate' };
    },
    callAnthropicMessages: async (model, body, signal, opts) => {
      const selection = selectMessagesModel(model, body.speed);
      if ('http' in selection) return selection;
      const { modelId } = selection;
      return await streaming('/messages', modelId, kimiCodeMessagesWireBody(body), signal, headersForAnthropicMessagesCall([...opts.headers], opts.anthropicBeta), body.speed === 'fast' || body.speed === 'standard' ? kimiCodeMessagesSpeedParser(body.speed === 'fast' ? 'fast' : 'standard') : parseAnthropicMessagesStream, opts);
    },
    callAnthropicMessagesCountTokens: async (model, body, signal, opts) => {
      const selection = selectMessagesModel(model, body.speed);
      if ('http' in selection) return selection;
      return {
        http: await call('/messages/count_tokens', selection.modelId, kimiCodeMessagesWireBody(body), signal, headersForAnthropicMessagesCall([...opts.headers], opts.anthropicBeta), opts, false),
        modelKey: selection.modelId,
      };
    },
    callAlphaSearch: unsupported('callAlphaSearch'),
    callGeminiGenerateContent: unsupported('callGeminiGenerateContent'),
    callGeminiGenerateContentCountTokens: unsupported('callGeminiGenerateContentCountTokens'),
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
