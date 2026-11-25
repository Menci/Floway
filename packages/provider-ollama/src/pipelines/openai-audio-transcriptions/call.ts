import type { OllamaServices } from '../../service.ts';
import { observeProbes } from '../observe-probes.ts';
import { prepareRequest, upstreamConfig } from '../prepare-request.ts';
import { stripOllamaHeaders } from '../strip-headers.ts';
import { getHeader } from '@floway-dev/http';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { formatOpenAIAudioTranscriptionsError, isOpenAIAudioTranscriptionDoneEvent, parseOpenAIAudioTranscriptionStream } from '@floway-dev/protocols/openai-audio';
import { httpTerminal, type ProviderOperationFacts, type ProviderTransportFacts, serializeMultipartHttpBody, serializeModelFieldOpenAIAudioTranscriptionRequest, parseSseBody, parseResultBody } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<'openaiAudioTranscriptions'> & ProviderTransportFacts, OllamaServices>();

const call = defineStage({
  name: 'ollama.openaiAudioTranscriptions.call',
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
        // https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/server/routes.go#L1916-L1922
        const request = prepareRequest(facts['request.http'], config, '/v1/audio/transcriptions', body, contentType);
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

export const openaiAudioTranscriptions = compose('ollama.openaiAudioTranscriptions', {
  entry: ['request.http', 'request.openaiAudioTranscriptions', 'provider.upstream', 'provider.model'],
  exit: ['response.http', 'response.modelKey', 'response.openaiAudioTranscriptions'],
  stages: [stripOllamaHeaders, call, observeProbes],
  ending: httpTerminal,
});
