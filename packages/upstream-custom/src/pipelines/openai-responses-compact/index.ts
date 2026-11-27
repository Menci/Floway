import { compose } from '../http.ts';
import { openaiResponsesCompactDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const openaiResponsesCompact = compose('custom.openaiResponsesCompact', {
  entry: ['http', 'upstream', 'model', 'openaiResponsesCompact'],
  exit: ['http', 'openaiResponsesCompact'],
  stages: [openaiResponsesCompactDial],
  ending: httpTerminal,
});
