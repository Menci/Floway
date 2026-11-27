import { compose } from '../http.ts';
import { openaiChatCompletionsDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const openaiChatCompletions = compose('custom.openaiChatCompletions', {
  entry: ['http', 'upstream', 'model', 'openaiChatCompletions'],
  exit: ['http', 'openaiChatCompletions'],
  stages: [openaiChatCompletionsDial],
  ending: httpTerminal,
});
