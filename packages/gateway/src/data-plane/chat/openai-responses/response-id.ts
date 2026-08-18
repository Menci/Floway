// One client response can span several upstream calls behind hosted tools,
// so the source boundary owns one envelope id independently of output items.
import { encodeHex } from '@floway-dev/protocols/common';

export const createOpenAIResponsesResponseId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `resp_${encodeHex(bytes)}`;
};
