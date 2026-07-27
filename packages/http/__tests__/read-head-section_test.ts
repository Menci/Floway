import { describe, expect, it } from 'vitest';

import { makeFakeDuplex, respondAndEnd } from './test-utils.ts';
import { HttpProtocolError } from '../src/errors.ts';
import { readHeadSection } from '../src/read-head-section.ts';

const HEADER_BUFFER_CAP = 64 * 1024;

const readResponseHeadSection = async (
  readable: ReadableStream<Uint8Array>,
): ReturnType<typeof readHeadSection> => {
  const reader = readable.getReader();
  try {
    return await readHeadSection(reader, new Uint8Array(0), {
      maxBytes: HEADER_BUFFER_CAP,
      decodeContext: 'response headers',
      eofError: receivedBytes => new HttpProtocolError(
        `unexpected EOF before headers; got ${receivedBytes} bytes`,
        'EOF',
      ),
      overflowError: maxBytes => new HttpProtocolError(
        `HTTP/1.1 response headers exceeded ${maxBytes} bytes without a terminator`,
        'HEADER_BUFFER_OVERFLOW',
      ),
    });
  } finally {
    reader.releaseLock();
  }
};

describe('readHeadSection', () => {
  it('rejects a head that grows past the configured buffer limit', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nX-Big: ');
    fake.respond('a'.repeat(70 * 1024));
    fake.endResponse();
    await expect(readResponseHeadSection(fake.readable)).rejects.toMatchObject({
      code: 'HEADER_BUFFER_OVERFLOW',
    });
  });

  it('rejects EOF before the head terminator', async () => {
    await expect(
      readResponseHeadSection(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Type:')),
    ).rejects.toMatchObject({ code: 'EOF' });
  });
});
