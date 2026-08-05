// Setup prefixes travel through UTF-8 HTTP response bodies before a shell
// parses them. NUL cannot exist in a shell word, and an unpaired UTF-16
// surrogate is replaced while the response is encoded, so neither value can be
// forwarded verbatim.
export const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
};

export const isScriptLiteralValue = (value: string): boolean => !value.includes('\0') && !hasLoneSurrogate(value);

export const assertScriptLiteralValue = (value: string): void => {
  if (!isScriptLiteralValue(value)) throw new Error('cannot render a value containing NUL or an unpaired surrogate');
};
