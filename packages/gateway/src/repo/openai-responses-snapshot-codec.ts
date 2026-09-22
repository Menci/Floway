import { z } from 'zod';

import { decodeStoredJson } from './stored-json.ts';

const itemIdsSchema = z.array(z.string());

export const decodeOpenAIResponsesSnapshotItemIds = (raw: string, id: string, apiKeyId: string): string[] =>
  decodeStoredJson(raw, itemIdsSchema, {
    malformed: `responses_snapshots.item_ids_json is malformed for id=${id}, api_key_id=${apiKeyId}`,
    invalid: `responses_snapshots.item_ids_json is invalid for id=${id}, api_key_id=${apiKeyId}`,
  });

export const encodeOpenAIResponsesSnapshotItemIds = (itemIds: readonly string[]): string => JSON.stringify(itemIds);
