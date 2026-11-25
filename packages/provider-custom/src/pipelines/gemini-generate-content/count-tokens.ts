import { geminiGenerateContentPath } from '../../endpoint.ts';
import { applyIngressHeaderRules } from '../apply-ingress-header-rules.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { factSpace, move, transform, type Result } from '@floway-dev/pipeline';
import { formatGeminiGenerateContentError, type GeminiGenerateContentCountTokensResult } from '@floway-dev/protocols/gemini-generate-content';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, parseResultBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'geminiGenerateContentCountTokens'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'custom.geminiGenerateContentCountTokens.call',
  through: {
    request: {
      needs: ['request.http', 'request.geminiGenerateContent', 'provider.upstream', 'provider.model'],
      provides: ['request.http'],
      consumes: [],
    },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.geminiGenerateContent'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(() => {
    let modelKey: string;
    return {
      request: facts => {
        const config = upstreamConfig(facts['provider.upstream']);
        const { upstreamModelId } = facts['provider.model'];
        modelKey = upstreamModelId.replace(/^models\//, '');
        const { generateContentRequest, ...contents } = facts['request.geminiGenerateContent'];
        const body = generateContentRequest === undefined
          ? contents
          : { generateContentRequest: { ...generateContentRequest, model: `models/${modelKey}` } };
        const request = prepareRequest(facts['request.http'], config, geminiGenerateContentPath(config, modelKey, 'countTokens'), body, { authStyle: 'x-goog-api-key' });
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const { http, outcome } = await parseResultBody(back, parseCountTokens, formatGeminiGenerateContentError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.geminiGenerateContent': move(outcome) };
      },
    };
  }),
});

const parseCountTokens = (bytes: Uint8Array): Result<GeminiGenerateContentCountTokensResult, unknown> => {
  const json = parseJsonObject(bytes);
  if (!json.ok) return json;
  const { totalTokens } = json.value;
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens)) {
    return { ok: false, error: new TypeError('Expected a finite totalTokens count') };
  }
  return { ok: true, value: { ...json.value, totalTokens } };
};

export const geminiGenerateContentCountTokens = compose('custom.geminiGenerateContentCountTokens', {
  entry: ['request.http', 'request.geminiGenerateContent', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.geminiGenerateContent'],
  stages: [applyIngressHeaderRules, call],
  ending: httpTerminal,
});
