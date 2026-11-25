export const serializeMultipartHttpBody = async (
  form: FormData,
): Promise<{ readonly body: Uint8Array<ArrayBuffer>; readonly contentType: string }> => {
  const response = new Response(form);
  const contentType = response.headers.get('content-type');
  if (contentType === null) throw new TypeError('Multipart serialization did not produce a Content-Type');
  return { body: new Uint8Array(await response.arrayBuffer()), contentType };
};
