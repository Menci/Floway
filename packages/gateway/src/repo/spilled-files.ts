import { getRepo } from './index.ts';
import { SPILLED_FILE_STAGE_GRACE_MS } from './spilled-files-policy.ts';
import { getFileProvider } from '@floway-dev/platform';

const CLAIM_TIMEOUT_MS = 60 * 60 * 1000;
const FILE_DELETE_BATCH_SIZE = 1_000;
const FILE_INVENTORY_PAGE_SIZE = 1_000;

export const inventorySpilledFiles = async (prefix: string, now: number): Promise<void> => {
  const repo = getRepo();
  const token = crypto.randomUUID();
  const claim = await repo.spilledFiles.claimInventory(token, prefix, now, now - CLAIM_TIMEOUT_MS);
  if (claim === null) return;
  try {
    const page = await getFileProvider().listPage(prefix, claim.cursor, FILE_INVENTORY_PAGE_SIZE);
    const completed = await repo.spilledFiles.completeInventory(
      token,
      prefix,
      claim.revision,
      page.keys,
      page.nextCursor,
      Date.now() + SPILLED_FILE_STAGE_GRACE_MS,
    );
    if (!completed) throw new Error(`Spilled-file inventory lost its claim for prefix: ${prefix}`);
  } catch (error) {
    await repo.spilledFiles.releaseInventory(token);
    throw error;
  }
};

export const collectSpilledFiles = async (now: number): Promise<void> => {
  const repo = getRepo();
  const token = crypto.randomUUID();
  const keys = await repo.spilledFiles.claimCollectible(
    token,
    now,
    now - CLAIM_TIMEOUT_MS,
    FILE_DELETE_BATCH_SIZE,
  );
  if (keys.length === 0) return;
  await getFileProvider().deleteKeys(keys);
  const acknowledged = await repo.spilledFiles.acknowledge(token);
  if (acknowledged !== keys.length) {
    throw new Error(`Spilled-file collection acknowledged ${acknowledged} of ${keys.length} claimed files`);
  }
};
