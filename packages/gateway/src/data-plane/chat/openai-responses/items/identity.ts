import { hashOpenAIResponsesJson } from '../../../../repo/openai-responses-hash.ts';
import { encodeHex } from '@floway-dev/protocols/common';

export const openaiResponsesItemId = (item: object): string | null => {
  const id = 'id' in item ? item.id : undefined;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

export const hashOpenAIResponsesItem = async (item: unknown): Promise<string> =>
  await hashOpenAIResponsesJson(item);

export const createOpenAIResponsesStorageKey = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `stored_${encodeHex(bytes)}`;
};
