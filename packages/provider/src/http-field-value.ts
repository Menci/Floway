// https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5
const isFieldVchar = (code: number): boolean =>
  (code >= 0x21 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);

export const isHttpFieldValue = (value: string): boolean => {
  if (value.length === 0) return true;
  if (!isFieldVchar(value.charCodeAt(0)) || !isFieldVchar(value.charCodeAt(value.length - 1))) return false;
  for (let index = 1; index < value.length - 1; index++) {
    const code = value.charCodeAt(index);
    if (code !== 0x09 && (code < 0x20 || code === 0x7f || code > 0xff)) return false;
  }
  return true;
};
