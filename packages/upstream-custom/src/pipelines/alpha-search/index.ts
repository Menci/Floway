import { compose } from '../http.ts';
import { alphaSearchDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const alphaSearch = compose('custom.alphaSearch', {
  entry: ['http', 'upstream', 'model', 'alphaSearch'],
  exit: ['http', 'alphaSearch'],
  stages: [alphaSearchDial],
  ending: httpTerminal,
});
