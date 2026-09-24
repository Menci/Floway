import { DynamicToolInputError, prepareDynamicTools } from './dynamic-tools/catalog.ts';
import { projectDynamicToolEvents } from './dynamic-tools/projection.ts';
import { bindDynamicToolCatalog, unbindDynamicToolCatalog } from './dynamic-tools/server-search.ts';
import type { OpenAIResponsesInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

export const withOpenAIResponsesDynamicToolShim: OpenAIResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (
    ctx.targetApi === 'openaiResponses'
    && !providerModelOf(ctx.candidate).enabledFlags.has('dynamic-tool-shim')
  ) return await run();

  let prepared;
  try {
    prepared = prepareDynamicTools(ctx.payload);
  } catch (error) {
    if (!(error instanceof DynamicToolInputError)) throw error;
    return {
      type: 'api-error',
      source: 'gateway',
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode(JSON.stringify({
        error: { type: 'invalid_request_error', message: error.message },
      })),
    };
  }

  ctx.payload = prepared.payload;
  bindDynamicToolCatalog(ctx, prepared.catalog);
  let result;
  try {
    result = await run();
  } finally {
    unbindDynamicToolCatalog(ctx);
  }
  if (result.type !== 'events') return result;
  return { ...result, events: projectDynamicToolEvents(result.events, prepared) };
};
