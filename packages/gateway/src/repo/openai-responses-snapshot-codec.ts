import { parseStoredJson } from './stored-json.ts';

export const decodeOpenAIResponsesSnapshotItemIds = (raw: string, id: string, apiKeyId: string): string[] =>
  parseStoredJson<string[]>(raw, `responses_snapshots.item_ids_json is malformed for id=${id}, api_key_id=${apiKeyId}`);

export const encodeOpenAIResponsesSnapshotItemIds = (itemIds: readonly string[]): string => JSON.stringify(itemIds);
