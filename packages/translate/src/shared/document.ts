export const DOCUMENT_OPEN_TAG = '<document>';
export const DOCUMENT_CLOSE_TAG = '</document>';

export const utf8Base64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
