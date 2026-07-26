import { concat, copy, findDoubleCrlfFrom } from './bytes.ts';
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
  let buffer = preBuffered;
  let headerEnd = findDoubleCrlfFrom(buffer, 0);
  while (headerEnd < 0) {
    const scanFrom = Math.max(0, buffer.byteLength - 3);
    const { value, done } = await reader.read();
    if (done) throw options.eofError(buffer.byteLength);
    buffer = concat(buffer, value);
    headerEnd = findDoubleCrlfFrom(buffer, scanFrom);
    if (headerEnd < 0 && buffer.byteLength > options.maxBytes) {
      throw options.overflowError(options.maxBytes);
    }
  }

  const headerBytes = buffer.subarray(0, headerEnd);
  const remainder = copy(buffer.subarray(headerEnd + 4));
  const lines = decodeAsciiHeaderSection(headerBytes, options.decodeContext).split('\r\n');
  const statusLine = lines.shift()!;
  return { statusLine, lines, remainder };
};
