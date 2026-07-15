import { test } from 'vitest';

import { imagesEditsJsonBody, imagesEditsMultipartBody } from './images.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('imagesEditsJsonBody preserves reference fields and nullable parameters', () => {
  const body = imagesEditsJsonBody({
    type: 'references',
    images: [{ image_url: 'https://example.test/image.png', detail: 'future-field' }],
    mask: { file_id: 'file-mask' },
    parameters: { prompt: 'edit', background: null },
  });
  assertEquals(body, {
    prompt: 'edit',
    background: null,
    images: [{ image_url: 'https://example.test/image.png', detail: 'future-field' }],
    mask: { file_id: 'file-mask' },
  });
});

test('imagesEditsMultipartBody uses the singular field for one upload and the array field for many', () => {
  const first = new File(['first'], 'first.png', { type: 'image/png' });
  const second = new File(['second'], 'second.png', { type: 'image/png' });
  const single = imagesEditsMultipartBody({
    type: 'uploads',
    images: [first],
    parameters: { prompt: 'single' },
  }, 'gpt-image');
  assertEquals(single.get('image'), first);
  assertEquals(single.getAll('image[]'), []);

  const multiple = imagesEditsMultipartBody({
    type: 'uploads',
    images: [first, second],
    parameters: { prompt: 'multiple' },
  }, 'gpt-image');
  assertEquals(multiple.getAll('image[]'), [first, second]);
  assertEquals(multiple.get('image'), null);
  assertEquals(multiple.get('model'), 'gpt-image');
});
