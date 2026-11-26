import { openaiAudioError } from './parse-transcriptions.ts';
import { jsonResponse, localResponseHead } from '../pipeline/encode.ts';
import { defineStage } from '../pipeline/facts.ts';
import { prepareJsonModelRequest } from '../shared/json-model-request.ts';
import { isJsonObject } from '@floway-dev/protocols/common';

export const parseOpenAIAudioSpeech = defineStage({
  name: 'openaiAudioSpeech.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiAudioSpeech'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.outcome'] },
  async execute(facts, scope) {
    const invalid = (message: string) => ({
      'response.http': jsonResponse(localResponseHead(400), openaiAudioError(message)),
      'response.outcome': scope.createDeferred(async () => 'local' as const),
    });
    const parsed = prepareJsonModelRequest(facts['request.http'].body ?? new Uint8Array(), 'OpenAI Audio Speech');
    if (parsed.type === 'invalid') return invalid(parsed.message);

    const { input, voice, stream_format: streamFormat, ...body } = parsed.body;
    if (typeof input !== 'string') return invalid('OpenAI Audio Speech request body must include an input string.');
    if (typeof voice !== 'string' && !(isJsonObject(voice) && typeof voice.id === 'string')) {
      return invalid('OpenAI Audio Speech request body must include a voice string or a voice object with an id.');
    }
    if (streamFormat !== undefined && typeof streamFormat !== 'string') {
      return invalid('OpenAI Audio Speech stream_format must be a string.');
    }
    return await scope.next({
      ...facts,
      'request.openaiAudioSpeech': {
        ...body,
        model: parsed.model,
        input,
        voice: typeof voice === 'string' ? voice : { ...voice, id: voice.id as string },
        ...(streamFormat === undefined ? {} : { stream_format: streamFormat }),
      },
    });
  },
});
