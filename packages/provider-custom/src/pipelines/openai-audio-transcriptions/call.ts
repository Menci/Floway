import { customPath } from '../../endpoint.ts';
import { applyIngressHeaderRules } from '../apply-ingress-header-rules.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { getHeader } from '@floway-dev/http';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { formatOpenAIAudioTranscriptionsError, isOpenAIAudioTranscriptionDoneEvent, parseOpenAIAudioTranscriptionStream } from '@floway-dev/protocols/openai-audio';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, serializeMultipartHttpBody, serializeModelFieldOpenAIAudioTranscriptionRequest, parseSseBody, parseResultBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'openaiAudioTranscriptions'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'custom.openaiAudioTranscriptions.call',
  through: {
    request: {
      needs: ['request.http', 'request.openaiAudioTranscriptions', 'provider.upstream', 'provider.model'],
      provides: ['request.http'],
      consumes: [],
    },
    response: {
      needs: ['response.transport'],
      provides: ['response.http', 'response.modelKey', 'response.openaiAudioTranscriptions'],
      consumes: ['response.transport'],
    },
  },
  execute: transform(scope => {
    let modelKey: string;
    return {
      request: async facts => {
        const config = upstreamConfig(facts['provider.upstream']);
        const { upstreamModelId } = facts['provider.model'];
        modelKey = upstreamModelId;
        const form = serializeModelFieldOpenAIAudioTranscriptionRequest(facts['request.openaiAudioTranscriptions'], modelKey);
        const { body, contentType } = await serializeMultipartHttpBody(form);
        const request = prepareRequest(facts['request.http'], config, customPath(config, '/audio/transcriptions'), body, { contentType });
        return { ...facts, 'request.http': move(request) };
      },
      response: async back => {
        const transport = back['response.transport'];
        const contentType = transport.ok ? getHeader(transport.value.headers, 'content-type') : undefined;
        const { http, outcome } = typeof contentType === 'string' && isEventStreamMediaType(contentType)
          ? await parseSseBody(back, scope, parseOpenAIAudioTranscriptionStream, { kind: 'terminalEvent', isTerminal: isOpenAIAudioTranscriptionDoneEvent }, formatOpenAIAudioTranscriptionsError)
          : await parseResultBody(back, bytes => ({ ok: true, value: bytes }), formatOpenAIAudioTranscriptionsError);
        const { 'response.transport': _transport, ...response } = back;
        return { ...response, 'response.http': move(http), 'response.modelKey': modelKey, 'response.openaiAudioTranscriptions': move(outcome) };
      },
    };
  }),
});

export const openaiAudioTranscriptions = compose('custom.openaiAudioTranscriptions', {
  entry: ['request.http', 'request.openaiAudioTranscriptions', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiAudioTranscriptions'],
  stages: [applyIngressHeaderRules, call],
  ending: httpTerminal,
});
