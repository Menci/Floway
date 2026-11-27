import { AUDIO_RESULT_BODY_BYTES, customModelRequest, customResult, customStream, defineStage, dialResponseConsumes, dialResponseNeeds, keepBytes } from '../http.ts';
import { decodeOpenAIAudioSpeechStream } from '@floway-dev/protocols/openai-audio';

export const openaiAudioSpeechDial = defineStage({
  name: 'custom.openaiAudioSpeech.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiAudioSpeech'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'openaiAudioSpeech'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, openaiAudioSpeech } = facts;
    const request = customModelRequest(http, upstream, '/audio/speech', model.upstreamModelId, openaiAudioSpeech);
    const answer = await scope.next({ ...facts, http: request });
    const parsed = openaiAudioSpeech.stream_format === 'sse'
      ? await customStream(answer, scope, decodeOpenAIAudioSpeechStream)
      : await customResult(answer, scope, keepBytes, AUDIO_RESULT_BODY_BYTES);
    return { http: parsed.http, openaiAudioSpeech: parsed.outcome };
  },
});
