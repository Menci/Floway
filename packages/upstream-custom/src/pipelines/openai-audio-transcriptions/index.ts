import { compose } from '../http.ts';
import { openaiAudioTranscriptionsDial } from './dial.ts';
import { openaiAudioTranscriptionsHttp } from './http.ts';

export const openaiAudioTranscriptions = compose('custom.openaiAudioTranscriptions', {
  entry: ['http', 'upstream', 'model', 'openaiAudioTranscriptions'],
  exit: ['http', 'openaiAudioTranscriptions'],
  stages: [openaiAudioTranscriptionsDial],
  ending: openaiAudioTranscriptionsHttp,
});
