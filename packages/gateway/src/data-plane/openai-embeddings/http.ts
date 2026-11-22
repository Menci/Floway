import { tokenUsageFromOpenAIEmbeddingsBody } from './usage.ts';
import { createGatewayHttpHandler } from '../pipeline/host.ts';
import { createNonChatPipeline, parseJsonModel, respondJsonUsage } from '../pipeline/non-chat.ts';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { ProviderHttpOutput } from '@floway-dev/provider';

const ingress = createNonChatPipeline<Omit<OpenAIEmbeddingsPayload, 'model'>, ProviderHttpOutput>({
  name: 'openai-embeddings',
  sourceApi: '/embeddings',
  operation: 'embeddings',
  kind: 'embedding',
  parse: request => {
    const parsed = parseJsonModel(request, 'OpenAI Embeddings');
    return 'error' in parsed ? parsed : { model: parsed.model, payload: parsed.payload as Omit<OpenAIEmbeddingsPayload, 'model'> };
  },
  provider: pipelines => pipelines.openaiEmbeddings,
  select: candidates => candidates.filter(candidate => candidate.endpoints.openaiEmbeddings !== undefined),
  respond: (response, _request, identity, env) => respondJsonUsage(response['response.http'], identity, env, '/embeddings', tokenUsageFromOpenAIEmbeddingsBody),
});

export const openaiEmbeddings = createGatewayHttpHandler(ingress, { errorStatus: () => 502, performanceOperation: 'embeddings' });
