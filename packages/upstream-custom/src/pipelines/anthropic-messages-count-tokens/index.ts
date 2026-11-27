import { compose } from '../http.ts';
import { anthropicMessagesCountTokensDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const anthropicMessagesCountTokens = compose('custom.anthropicMessagesCountTokens', {
  entry: ['http', 'upstream', 'model', 'anthropicMessagesCountTokens'],
  exit: ['http', 'anthropicMessagesCountTokens'],
  stages: [anthropicMessagesCountTokensDial],
  ending: httpTerminal,
});
