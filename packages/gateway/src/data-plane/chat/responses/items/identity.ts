import { hashResponsesJson } from '../../../../repo/responses-hash.ts';
import { encodeHex } from '../../../../shared/base-encoding.ts';

export const responsesItemId = (item: object): string | null => {
  const id = 'id' in item ? item.id : undefined;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

export const hashResponsesItem = async (item: unknown): Promise<string> =>
  await hashResponsesJson(item);

export const createResponsesStorageKey = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `stored_${encodeHex(bytes)}`;
};
