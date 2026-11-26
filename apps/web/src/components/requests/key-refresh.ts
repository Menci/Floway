import type { ApiResult } from '../../api/client';
import type { ApiKey } from '../../api/types';

export const refreshRequestKeys = async ({
  allKeys,
  currentKeys,
  load,
  onNavigate,
  onUpdate,
  selectedKeyId,
  signal,
}: {
  allKeys: boolean;
  currentKeys: ApiKey[] | null;
  load: (signal: AbortSignal) => Promise<ApiResult<ApiKey[]>>;
  onNavigate: (keyId: string | null) => void;
  onUpdate: (keys: ApiKey[] | null, error: string | null) => void;
  selectedKeyId: string | null;
  signal: AbortSignal;
}) => {
  const result = await load(signal);
  if (signal.aborted) return;
  if (result.error) {
    onUpdate(currentKeys, result.error.message);
    return;
  }

  const keys = result.data.filter(key => key.dump_retention_seconds !== null);
  // The merged scope survives any key coming or going: it is still a valid
  // view of whatever remains, and navigating away would lose the reader's
  // place for a background refresh.
  if (allKeys) {
    onUpdate(keys, null);
    return;
  }
  const nextSelectedKeyId = keys.some(key => key.id === selectedKeyId)
    ? selectedKeyId
    : keys[0]?.id ?? null;
  if (nextSelectedKeyId !== selectedKeyId) {
    onNavigate(nextSelectedKeyId);
    return;
  }
  onUpdate(keys, null);
};
