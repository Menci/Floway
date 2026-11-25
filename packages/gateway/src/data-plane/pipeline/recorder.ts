import type { AuthedContext } from '../../middleware/auth.ts';
import type { RunEvent } from '@floway-dev/pipeline';

export interface PipelineRecorder {
  readonly event: (event: RunEvent) => void;
  readonly finish: () => void | Promise<void>;
}

export type OpenPipelineRecorder = (c: AuthedContext, apiKeyId: string) => PipelineRecorder | null;

export const openPipelineRecorder: OpenPipelineRecorder = () => null;
