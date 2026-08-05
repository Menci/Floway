import { copy, findDoubleCrlfFrom } from './bytes.ts';
import { decodeAsciiHeaderSection } from './grammar.ts';

interface ReadHeadSectionOptions {
  maxBytes: number;
  decodeContext: string;
  eofError: (receivedBytes: number) => Error;
  overflowError: (maxBytes: number) => Error;
}

interface HeadSection {
  statusLine: string;
  lines: string[];
  remainder: Uint8Array;
}

export const readHeadSection = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  preBuffered: Uint8Array,
  options: ReadHeadSectionOptions,
): Promise<HeadSection> => {
  let length = preBuffered.byteLength;
  let storage = new Uint8Array(Math.max(1024, length));
  storage.set(preBuffered);
  const bytes = (): Uint8Array => storage.subarray(0, length);
  const append = (chunk: Uint8Array): void => {
    const required = length + chunk.byteLength;
    if (required > storage.byteLength) {
      const grown = Math.max(required, storage.byteLength * 2);
      const next = new Uint8Array(grown);
      next.set(storage.subarray(0, length));
      storage = next;
    }
    storage.set(chunk, length);
    length = required;
  };

  let buffer = bytes();
  let headerEnd = findDoubleCrlfFrom(buffer, 0);
  while (headerEnd < 0) {
    const scanFrom = Math.max(0, buffer.byteLength - 3);
    const { value, done } = await reader.read();
    if (done) throw options.eofError(buffer.byteLength);
    append(value);
    buffer = bytes();
    headerEnd = findDoubleCrlfFrom(buffer, scanFrom);
    if (headerEnd < 0 && buffer.byteLength > options.maxBytes) {
      throw options.overflowError(options.maxBytes);
    }
  }
  // A complete terminator in the same transport chunk used to bypass the
  // in-loop overflow branch. Enforce the cap against the actual head length
  // regardless of how the peer packetized it.
  if (headerEnd > options.maxBytes) {
    throw options.overflowError(options.maxBytes);
  }

  const headerBytes = buffer.subarray(0, headerEnd);
  const remainder = copy(buffer.subarray(headerEnd + 4));
  const lines = decodeAsciiHeaderSection(headerBytes, options.decodeContext).split('\r\n');
  const statusLine = lines.shift()!;
  return { statusLine, lines, remainder };
};
