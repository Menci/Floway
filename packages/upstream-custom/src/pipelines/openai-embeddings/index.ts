import { compose } from '../http.ts';
import { openaiEmbeddingsDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const openaiEmbeddings = compose('custom.openaiEmbeddings', {
  entry: ['http', 'upstream', 'model', 'openaiEmbeddings'],
  exit: ['http', 'openaiEmbeddings'],
  stages: [openaiEmbeddingsDial],
  ending: httpTerminal,
});
