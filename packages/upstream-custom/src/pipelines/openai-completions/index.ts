import { compose } from '../http.ts';
import { openaiCompletionsDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const openaiCompletions = compose('custom.openaiCompletions', {
  entry: ['http', 'upstream', 'model', 'openaiCompletions'],
  exit: ['http', 'openaiCompletions'],
  stages: [openaiCompletionsDial],
  ending: httpTerminal,
});
