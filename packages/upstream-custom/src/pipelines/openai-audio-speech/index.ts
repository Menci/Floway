import { compose } from '../http.ts';
import { openaiAudioSpeechDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const openaiAudioSpeech = compose('custom.openaiAudioSpeech', {
  entry: ['http', 'upstream', 'model', 'openaiAudioSpeech'],
  exit: ['http', 'openaiAudioSpeech'],
  stages: [openaiAudioSpeechDial],
  ending: httpTerminal,
});
