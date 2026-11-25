import type { CopilotModelsResponse } from './types.ts';
import type { HttpBodyError, HttpResponseFact } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { fetchUpstreamModels } from '@floway-dev/provider';

const isCopilotModelsResponse = (value: unknown): value is CopilotModelsResponse => {
  const response = value as CopilotModelsResponse;
  return typeof response?.object === 'string'
    && Array.isArray(response.data)
    && response.data.every(model => typeof model?.id === 'string');
};

export const fetchCopilotModels = (fetch: () => Promise<Response>): Promise<CopilotModelsResponse> =>
  fetchUpstreamModels(fetch, value => isCopilotModelsResponse(value) ? value : null);

type CatalogBody = AsyncGenerator<Result<Uint8Array, HttpBodyError>, void, unknown>;

export const responseForCatalog = ({ body, headers, status, statusText }: Omit<HttpResponseFact, 'body'> & { body: CatalogBody | null }): Response => {
  const stream = body === null ? null : new ReadableStream<Uint8Array>({
    async pull(controller) {
      const item = await body.next();
      if (item.done) controller.close();
      else if (item.value.ok) controller.enqueue(item.value.value);
      else {
        controller.error(item.value.error.cause);
        await body.return();
      }
    },
    async cancel() {
      await body.return();
    },
  });
  const plain = new Headers(headers.map(([name, value]) => {
    if (typeof value !== 'string') throw new TypeError(`Copilot response header ${name} must be plain text`);
    return [name, value];
  }));
  return new Response(stream, { status, statusText, headers: plain });
};
