export const decodeOpenAIResponsesSnapshotItemIds = (raw: string, id: string, apiKeyId: string): string[] => {
  try {
    return JSON.parse(raw) as string[];
  } catch (cause) {
    throw new Error(`responses_snapshots.item_ids_json is malformed for id=${id}, api_key_id=${apiKeyId}`, { cause });
  }
};

export const encodeOpenAIResponsesSnapshotItemIds = (itemIds: readonly string[]): string => JSON.stringify(itemIds);
