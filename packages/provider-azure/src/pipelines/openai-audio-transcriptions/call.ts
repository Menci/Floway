import { azureDeploymentScopedOpenAIAudioTranscriptionUrl } from '../../endpoint.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { stripAzureHeaders } from '../strip-headers.ts';
import { getHeader } from '@floway-dev/http';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { formatOpenAIAudioTranscriptionsError, isOpenAIAudioTranscriptionDoneEvent, parseOpenAIAudioTranscriptionStream } from '@floway-dev/protocols/openai-audio';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, type ProviderServices, serializeMultipartHttpBody, serializeModelPathOpenAIAudioTranscriptionRequest, parseSseBody, parseResultBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'openaiAudioTranscriptions'> & ProviderTransportFacts, ProviderServices>();

const call = defineStage({
  name: 'azure.openaiAudioTranscriptions.call',
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
        const form = serializeModelPathOpenAIAudioTranscriptionRequest(facts['request.openaiAudioTranscriptions']);
        const { body, contentType } = await serializeMultipartHttpBody(form);
        const request = prepareRequest(facts['request.http'], config, azureDeploymentScopedOpenAIAudioTranscriptionUrl(config.endpoint, modelKey), body, { contentType });
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

export const openaiAudioTranscriptions = compose('azure.openaiAudioTranscriptions', {
  entry: ['request.http', 'request.openaiAudioTranscriptions', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiAudioTranscriptions'],
  stages: [stripAzureHeaders, call],
  ending: httpTerminal,
});
