import { compose } from '../http.ts';
import { openaiImagesGenerationsDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const openaiImagesGenerations = compose('custom.openaiImagesGenerations', {
  entry: ['http', 'upstream', 'model', 'openaiImagesGenerations'],
  exit: ['http', 'openaiImagesGenerations'],
  stages: [openaiImagesGenerationsDial],
  ending: httpTerminal,
});
