import { expect, test, vi } from 'vitest';

import { requestApp, setupAppTest } from '../../test-utils/app.ts';

test.each([
  ['/v1/audio/transcriptions', 'file', 'OpenAI Audio Transcriptions'],
  ['/v1/images/edits', 'image', 'OpenAI Images Edits'],
] as const)('%s rejects malformed multipart and exposes a file read defect', async (path, field, protocol) => {
  const { apiKey } = await setupAppTest();
  const malformed = await requestApp(path, {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'multipart/form-data; boundary=broken' },
    body: 'invalid multipart body',
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toMatchObject({
    error: { message: `${protocol} request body must be valid multipart/form-data.` },
  });

  const form = new FormData();
  form.append('model', 'test-model');
  form.append(field, new File(['abc'], 'fixture'));
  const defect = new TypeError('unexpected file access');
  const read = vi.spyOn(File.prototype, 'arrayBuffer').mockRejectedValueOnce(defect);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const panic = await requestApp(path, {
      method: 'POST',
      headers: { 'x-api-key': apiKey.key },
      body: form,
    });
    expect(read).toHaveBeenCalledOnce();
    expect(panic.status).toBe(500);
    expect(await panic.json()).toMatchObject({
      error: { name: 'TypeError', message: defect.message, stack: defect.stack },
    });
  } finally {
    read.mockRestore();
    log.mockRestore();
  }
});
