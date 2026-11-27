import { compose } from '../http.ts';
import { geminiGenerateContentDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const geminiGenerateContent = compose('custom.geminiGenerateContent', {
  entry: ['http', 'upstream', 'model', 'geminiGenerateContent'],
  exit: ['http', 'geminiGenerateContent'],
  stages: [geminiGenerateContentDial],
  ending: httpTerminal,
});
