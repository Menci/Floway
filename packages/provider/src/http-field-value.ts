// https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5
export const isHttpFieldValue = (value: string): boolean => [...value].every(char => {
  const code = char.charCodeAt(0);
  return code === 0x09 || (code >= 0x20 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
});
