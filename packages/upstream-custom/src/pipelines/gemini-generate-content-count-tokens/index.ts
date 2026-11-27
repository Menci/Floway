import { compose } from '../http.ts';
import { geminiGenerateContentCountTokensDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const geminiGenerateContentCountTokens = compose('custom.geminiGenerateContentCountTokens', {
  entry: ['http', 'upstream', 'model', 'geminiGenerateContentCountTokens'],
  exit: ['http', 'geminiGenerateContentCountTokens'],
  stages: [geminiGenerateContentCountTokensDial],
  ending: httpTerminal,
});
