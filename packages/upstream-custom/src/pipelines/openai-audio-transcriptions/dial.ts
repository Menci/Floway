import { pathOverrideFor } from '../../endpoints.ts';
import { AUDIO_RESULT_BODY_BYTES, customConfig, customRequest, customResult, customStream, defineStage, dialResponseConsumes, dialResponseNeeds } from '../http.ts';
import { contentTypeOf } from './content-type.ts';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { decodeOpenAIAudioTranscriptionsResult, decodeOpenAIAudioTranscriptionsStream } from '@floway-dev/protocols/openai-audio';
import { serializeOpenAIAudioTranscriptionsBody } from '@floway-dev/upstream';

export const openaiAudioTranscriptionsDial = defineStage({
  name: 'custom.openaiAudioTranscriptions.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiAudioTranscriptions'], provides: ['http'], consumes: [] },
    response: {
      needs: [...dialResponseNeeds, 'custom.openaiAudioTranscriptions.stream?'],
      provides: ['http', 'openaiAudioTranscriptions'],
      consumes: [...dialResponseConsumes, 'custom.openaiAudioTranscriptions.stream'],
    },
  },
  async execute(facts, scope) {
    const { http, upstream, model, openaiAudioTranscriptions } = facts;
    const config = customConfig(upstream);
    const content = await serializeOpenAIAudioTranscriptionsBody(openaiAudioTranscriptions, { type: 'replace', value: model.upstreamModelId });
    const request = customRequest(http, config, pathOverrideFor(config, '/audio/transcriptions'), content);
    const { 'custom.openaiAudioTranscriptions.stream': transcript, ...answer } = await scope.next({ ...facts, http: request });
    if (transcript !== undefined) return { http: answer.http, openaiAudioTranscriptions: transcript };
    const parsed = answer.http !== null && isEventStreamMediaType(contentTypeOf(answer.http))
      ? await customStream(answer, scope, decodeOpenAIAudioTranscriptionsStream)
      : await customResult(answer, scope, (bytes, head) => decodeOpenAIAudioTranscriptionsResult(bytes, contentTypeOf(head)), AUDIO_RESULT_BODY_BYTES);
    return { http: parsed.http, openaiAudioTranscriptions: parsed.outcome };
  },
});
