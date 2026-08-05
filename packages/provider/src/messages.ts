// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/beta.ts#L622-L635
export const headersForMessagesCall = (ordinaryHeaders: Headers, anthropicBeta: readonly string[]): Headers => {
  const headers = new Headers(ordinaryHeaders);
  headers.delete('anthropic-beta');
  if (anthropicBeta.length > 0) headers.set('anthropic-beta', anthropicBeta.join(','));
  return headers;
};
