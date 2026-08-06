const isHighSurrogate = (codeUnit: number): boolean => codeUnit >= 0xD800 && codeUnit <= 0xDBFF;
const isLowSurrogate = (codeUnit: number): boolean => codeUnit >= 0xDC00 && codeUnit <= 0xDFFF;

export const isStorageId = (value: string): boolean => {
  if (value.length === 0 || value.includes('\0')) return false;
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (isHighSurrogate(codeUnit)) {
      if (!isLowSurrogate(value.charCodeAt(index + 1))) return false;
      index += 1;
    } else if (isLowSurrogate(codeUnit)) {
      return false;
    }
  }
  return true;
};

export const assertStorageId = (value: string, field: string): void => {
  if (!isStorageId(value)) {
    throw new TypeError(`${field} must be a non-empty string without NUL or unpaired UTF-16 surrogates`);
  }
};
