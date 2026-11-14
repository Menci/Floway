import type { CopilotAuth } from './auth.ts';
import type { CopilotOperation, CopilotOperationRequest } from './pipeline-facts.ts';
import { authenticateCopilot } from './stages/authenticate.ts';
import { observeCopilotQuota } from './stages/observe-quota.ts';
import { prepareCopilotRequest } from './stages/prepare-request.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import type { ProviderPipelines, ProviderResponse } from '@floway-dev/provider';

export const createCopilotPipelines = (auth: CopilotAuth): ProviderPipelines => {
  const pipeline = <O extends CopilotOperation>(operation: O) =>
    compose<CopilotOperationRequest<O>, ProviderResponse>(`copilot.${operation}`, [authenticateCopilot(auth, operation), prepareCopilotRequest(operation), observeCopilotQuota(auth.id), http]);
  return {
    openaiEmbeddings: pipeline('openaiEmbeddings'),
    openaiImagesGenerations: pipeline('openaiImagesGenerations'),
    openaiImagesEdits: pipeline('openaiImagesEdits'),
    decision: pipeline('decision'),
  };
};
