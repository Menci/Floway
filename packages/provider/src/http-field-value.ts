// https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5
export const isHttpFieldValue = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code !== 0x09 && (code < 0x20 || code === 0x7f || code > 0xff)) return false;
  }
  return true;
};
