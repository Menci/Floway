import type { CopilotAuth } from './auth.ts';
import type { EmbeddingsRequest } from './pipeline-facts.ts';
import { authenticateCopilot } from './stages/authenticate.ts';
import { observeCopilotQuota } from './stages/observe-quota.ts';
import { prepareCopilotEmbeddings } from './stages/prepare-request.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import type { ProviderPipelines, ProviderResponse } from '@floway-dev/provider';

export const createCopilotPipelines = (auth: CopilotAuth): ProviderPipelines => ({
  openaiEmbeddings: compose<EmbeddingsRequest, ProviderResponse>('copilot.openaiEmbeddings', [authenticateCopilot(auth), prepareCopilotEmbeddings(), observeCopilotQuota(auth.id), http]),
});
