export interface UploadedFile {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export const readUploadedFile = async (file: File): Promise<UploadedFile> => ({
  name: file.name,
  type: file.type,
  bytes: new Uint8Array(await file.arrayBuffer()),
});

export const multipartFile = ({ name, type, bytes }: UploadedFile): File => new File([bytes], name, { type });

export const serializeMultipartHttpBody = async (
  form: FormData,
): Promise<{ readonly body: Uint8Array<ArrayBuffer>; readonly contentType: string }> => {
  const response = new Response(form);
  const contentType = response.headers.get('content-type');
  if (contentType === null) throw new TypeError('Multipart serialization did not produce a Content-Type');
  return { body: new Uint8Array(await response.arrayBuffer()), contentType };
};
