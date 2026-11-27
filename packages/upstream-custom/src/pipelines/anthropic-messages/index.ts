import { compose } from '../http.ts';
import { anthropicMessagesDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const anthropicMessages = compose('custom.anthropicMessages', {
  entry: ['http', 'upstream', 'model', 'anthropicMessages'],
  exit: ['http', 'anthropicMessages'],
  stages: [anthropicMessagesDial],
  ending: httpTerminal,
});
