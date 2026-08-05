// Counts the bytes TextEncoder would emit without allocating a second copy of
// an already-buffered string. Unpaired UTF-16 surrogates encode as U+FFFD.
export const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7F) {
      bytes += 1;
    } else if (codeUnit <= 0x7FF) {
      bytes += 2;
    } else if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
};
