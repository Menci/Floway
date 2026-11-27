import type { MultipartFile } from '@floway-dev/protocols/common';

export const uploadFile = ({ name, mediaType, bytes }: MultipartFile): File => {
  const contents = bytes.buffer instanceof ArrayBuffer ? bytes as Uint8Array<ArrayBuffer> : new Uint8Array(bytes);
  return new File([contents], name, { type: mediaType });
};

export const serializeMultipartBody = async (form: FormData): Promise<{ body: Uint8Array<ArrayBuffer>; contentType: string }> => {
  const response = new Response(form);
  const contentType = response.headers.get('content-type');
  if (contentType === null) throw new Error('Multipart serialization must supply a Content-Type');
  return { body: new Uint8Array(await response.arrayBuffer()), contentType };
};
