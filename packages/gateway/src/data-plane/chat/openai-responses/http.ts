import { createOpenAIResponsesHttpStore } from './items/store.ts';
import { openAIResponsesHttpPipeline } from './pipeline/index.ts';
import { openAIResponsesServices } from './pipeline/services.ts';
import { apiKeyFromContext, type AuthedContext } from '../../../middleware/auth.ts';
import { servePipeline } from '../../pipeline/host.ts';

const generate = openAIResponsesHttpPipeline('generate');
const compact = openAIResponsesHttpPipeline('compact');

const serve = (c: AuthedContext, pipeline: typeof generate) => {
  const apiKey = apiKeyFromContext(c);
  const startedAt = Date.now();
  return servePipeline(c, pipeline, input => openAIResponsesServices(
    input,
    (requestStartedAt, store) => createOpenAIResponsesHttpStore(apiKey, requestStartedAt, store),
    startedAt,
  ));
};

export const openaiResponsesHttp = {
  generate: (c: AuthedContext) => serve(c, generate),
  compact: (c: AuthedContext) => serve(c, compact),
};
