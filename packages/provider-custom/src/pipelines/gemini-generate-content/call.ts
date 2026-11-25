import { geminiGenerateContentPath } from '../../endpoint.ts';
import { applyIngressHeaderRules } from '../apply-ingress-header-rules.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { formatGeminiGenerateContentError, parseGeminiGenerateContentStream } from '@floway-dev/protocols/gemini-generate-content';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, parseSseBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'geminiGenerateContent'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'custom.geminiGenerateContent.call',
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
  execute: transform(scope => {
    let modelKey: string;
    return {
      request: facts => {
        const config = upstreamConfig(facts['provider.upstream']);
        const { upstreamModelId } = facts['provider.model'];
        modelKey = upstreamModelId.replace(/^models\//, '');
        const request = prepareRequest(facts['request.http'], config, geminiGenerateContentPath(config, modelKey, 'streamGenerateContent'), facts['request.geminiGenerateContent'], { authStyle: 'x-goog-api-key' });
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const { http, outcome } = await parseSseBody(back, scope, parseGeminiGenerateContentStream, { kind: 'complete' }, formatGeminiGenerateContentError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.geminiGenerateContent': move(outcome) };
      },
    };
  }),
});

export const geminiGenerateContent = compose('custom.geminiGenerateContent', {
  entry: ['request.http', 'request.geminiGenerateContent', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.geminiGenerateContent'],
  stages: [applyIngressHeaderRules, call],
  ending: httpTerminal,
});
