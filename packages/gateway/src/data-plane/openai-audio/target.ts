import type { Failure } from '../pipeline/facts.ts';
import type { ModelCandidate } from '@floway-dev/provider';

/** Nothing about this request narrows a candidate further. A transcription's parameters are
 *  form fields the upstream reads for itself, and no endpoint metadata says which renderings
 *  a model can write — so exposing the endpoint is the whole of the test. */
export const narrowing = {
  kind: 'transcription' as const,
  reject: (candidate: ModelCandidate): string | null =>
    candidate.model.endpoints.openaiAudioTranscriptions === undefined
      ? 'the upstream does not expose an OpenAI Audio Transcriptions endpoint'
      : null,
  unsupported: (model: string) => `Model ${model} does not support the /audio/transcriptions endpoint.`,
  refuse: (status: number, message: string) => ({
    'response.openaiAudioTranscription.canonical': { status, message } as Failure,
    'response.openaiAudioTranscription.mediaType': null,
    'response.openaiAudioTranscription.streamedOutcome': null,
  }),
  refuses: [
    'response.openaiAudioTranscription.canonical',
    'response.openaiAudioTranscription.mediaType',
    'response.openaiAudioTranscription.streamedOutcome',
  ] as const,
};
