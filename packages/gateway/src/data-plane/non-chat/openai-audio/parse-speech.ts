import { defineStage } from '../../pipeline/facts.ts';
import { jsonResponse, localHead, openAIError, readJsonModel } from '../shared/http.ts';
import { isJsonObject } from '@floway-dev/protocols/common';

export const parseOpenAIAudioSpeech = defineStage({
  name: 'openaiAudioSpeech.parse',
  through: {
    request: { needs: ['http'], provides: ['openaiAudioSpeech'], consumes: [] },
    response: { needs: ['http'], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute(facts, scope) {
    const invalid = (message: string) => {
      scope.services.dump?.error('gateway');
      return { http: jsonResponse(localHead(400), openAIError(message)) };
    };
    const parsed = readJsonModel(facts.http, 'OpenAI Audio Speech');
    if (!parsed.ok) return invalid(parsed.error);
    const { model, body } = parsed.value;
    scope.services.dump?.requestedModel(model);
    const { input, voice, stream_format: streamFormat, ...rest } = body;
    if (typeof input !== 'string') return invalid('OpenAI Audio Speech request body must include an input string.');
    const parsedVoice = typeof voice === 'string'
      ? voice
      : isJsonObject(voice) && typeof voice.id === 'string' ? { ...voice, id: voice.id } : null;
    if (parsedVoice === null) {
      return invalid('OpenAI Audio Speech request body must include a voice string or a voice object with an id.');
    }
    if (streamFormat !== undefined && typeof streamFormat !== 'string') {
      return invalid('OpenAI Audio Speech stream_format must be a string.');
    }
    return await scope.next({
      ...facts,
      openaiAudioSpeech: {
        ...rest,
        model,
        input,
        voice: parsedVoice,
        ...(streamFormat === undefined ? {} : { stream_format: streamFormat }),
      },
    });
  },
});
