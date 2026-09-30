import { expect, test } from 'vitest';

import { MODEL_ERROR_EDITOR_LENGTH, MODEL_ERROR_TOOLTIP_LENGTH, modelErrorExcerpt } from '../../../src/components/upstreams/model-error';

test('model error previews are shorter than the stored diagnostic', () => {
  const message = 'x'.repeat(MODEL_ERROR_EDITOR_LENGTH + 100);

  expect(modelErrorExcerpt(message, MODEL_ERROR_TOOLTIP_LENGTH)).toHaveLength(MODEL_ERROR_TOOLTIP_LENGTH);
  expect(modelErrorExcerpt(message, MODEL_ERROR_EDITOR_LENGTH)).toHaveLength(MODEL_ERROR_EDITOR_LENGTH);
  expect(modelErrorExcerpt(message, MODEL_ERROR_EDITOR_LENGTH).endsWith('…')).toBe(true);
  expect(message).toHaveLength(MODEL_ERROR_EDITOR_LENGTH + 100);
});
