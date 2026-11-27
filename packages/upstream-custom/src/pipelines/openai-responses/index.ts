import { compose } from '../http.ts';
import { openaiResponsesDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const openaiResponses = compose('custom.openaiResponses', {
  entry: ['http', 'upstream', 'model', 'openaiResponses'],
  exit: ['http', 'openaiResponses'],
  stages: [openaiResponsesDial],
  ending: httpTerminal,
});
