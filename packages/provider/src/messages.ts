import type { HttpHeaderLines } from '@floway-dev/http';

// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/beta.ts#L622-L635
export const headersForMessagesCall = (ordinaryHeaders: HttpHeaderLines, anthropicBeta: readonly string[]): HttpHeaderLines => {
  const headers = ordinaryHeaders.filter(([name]) => name.toLowerCase() !== 'anthropic-beta');
  return anthropicBeta.length > 0 ? [...headers, ['anthropic-beta', anthropicBeta.join(',')]] : headers;
};
