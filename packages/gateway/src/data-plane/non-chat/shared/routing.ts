import type { UpstreamOperation } from '@floway-dev/upstream';

export const httpEntry = ['http', 'serve.startedAt'] as const;
export const httpExit = ['http', 'candidate?', 'usage?'] as const;

export const providerBoundary = <const Operation extends UpstreamOperation>(operation: Operation) => ({
  request: { needs: ['http', 'upstream', 'model', operation], provides: [], consumes: [] },
  response: { needs: ['http', operation, 'usageModelKey?'], provides: [], consumes: [] },
} as const);

export const unavailableModel = (model: string, endpoint: string, exists: boolean): string =>
  exists
    ? `Model ${model} does not support the ${endpoint} endpoint.`
    : `Model ${model} is not available on any configured upstream.`;
