import { compose } from '../http.ts';
import { openaiImagesEditsDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const openaiImagesEdits = compose('custom.openaiImagesEdits', {
  entry: ['http', 'upstream', 'model', 'openaiImagesEdits'],
  exit: ['http', 'openaiImagesEdits'],
  stages: [openaiImagesEditsDial],
  ending: httpTerminal,
});
