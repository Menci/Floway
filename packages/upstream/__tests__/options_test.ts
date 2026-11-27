import { expect, test } from 'vitest';

import { directFetcher } from '../src/options.ts';

test('directFetcher rejects a replayable body without runtime composition', async () => {
  await expect(directFetcher('https://example.com', {
    method: 'POST',
    body: { contentLength: 0, open: () => new ReadableStream() },
  })).rejects.toThrow();
});
