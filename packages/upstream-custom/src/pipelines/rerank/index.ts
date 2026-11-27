import { compose } from '../http.ts';
import { rerankDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const rerank = compose('custom.rerank', {
  entry: ['http', 'upstream', 'model', 'rerank'],
  exit: ['http', 'rerank'],
  stages: [rerankDial],
  ending: httpTerminal,
});
