import { tokenUsageFromOpenAIEmbeddingsBody } from './usage.ts';
import { createGatewayHttpHandler } from '../pipeline/host.ts';
import { createNonChatPipeline, parseJsonModel, respondJsonUsage } from '../pipeline/non-chat.ts';
import { openaiEmbeddingsProviderTargets } from '../providers/upstreams.ts';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';

const ingress = createNonChatPipeline({
  name: 'openai-embeddings',
  sourceApi: '/embeddings',
  operation: 'embeddings',
  kind: 'embedding',
  parse: request => {
    const parsed = parseJsonModel(request, 'OpenAI Embeddings');
    return 'error' in parsed ? parsed : { model: parsed.model, payload: parsed.payload as Omit<OpenAIEmbeddingsPayload, 'model'> };
  },
  outcomeKey: 'response.openaiEmbeddings',
  targets: openaiEmbeddingsProviderTargets,
  select: candidates => candidates.filter(candidate => candidate.endpoints.openaiEmbeddings !== undefined),
  respond: (response, _request, identity, scope) => respondJsonUsage(response['response.http'], identity, scope, '/embeddings', tokenUsageFromOpenAIEmbeddingsBody),
});

export const openaiEmbeddings = createGatewayHttpHandler(ingress, { errorStatus: () => 502 });
