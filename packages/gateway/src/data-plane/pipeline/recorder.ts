import { createPipelineRecorder } from '../../dump/archive-recorder.ts';
import { getDumpArchiveStore } from '../../dump/registry.ts';
import { apiKeyFromContext, type AuthedContext } from '../../middleware/auth.ts';
import type { RunEvent } from '@floway-dev/pipeline';

export interface PipelineRecorder {
  readonly event: (event: RunEvent) => void;
  readonly finish: () => void | Promise<void>;
}

export type OpenPipelineRecorder = (c: AuthedContext, apiKeyId: string) => PipelineRecorder | null;

export const openPipelineRecorder: OpenPipelineRecorder = (c, apiKeyId) => {
  if (apiKeyFromContext(c).dumpRetentionSeconds === null) return null;
  return createPipelineRecorder(apiKeyId, async (keyId, id, bytes) => await getDumpArchiveStore().writeArchive(keyId, id, bytes));
};
