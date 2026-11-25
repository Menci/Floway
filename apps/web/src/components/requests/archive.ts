import { abortOptions, api, callApi } from '../../api/client';

export const ARCHIVE_PAGE_SIZE = 100;

export interface RequestArchive {
  readonly id: string;
  readonly contents: string;
}

export const getArchive = async (keyId: string, recordId: string, signal?: AbortSignal): Promise<RequestArchive> => {
  const response = await api.api.dump.keys[':keyId'].records[':recordId'].$get({ param: { keyId, recordId } }, abortOptions(signal));
  if (!response.ok) {
    const result = await callApi(async () => response);
    throw new Error(result.error?.message ?? `HTTP ${response.status}`);
  }
  return { id: recordId, contents: await response.text() };
};

export const listArchives = (keyId: string, q: string, failures: boolean, signal: AbortSignal, before?: string) =>
  callApi(() => api.api.dump.keys[':keyId'].records.$get({
    param: { keyId },
    query: { limit: String(ARCHIVE_PAGE_SIZE), q, failures: failures ? 'true' : 'false', ...(before !== undefined && { before }) },
  }, abortOptions(signal)));
