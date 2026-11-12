const utf16Bytes = (text: string): Uint8Array<ArrayBuffer> => {
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < text.length; index++) view.setUint16(index * 2, text.charCodeAt(index), true);
  return bytes;
};

export const hashRoundTripContent = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', utf16Bytes(text)), 0, 8);
