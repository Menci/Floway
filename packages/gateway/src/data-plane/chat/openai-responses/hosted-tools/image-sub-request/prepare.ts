import type { Fields } from './facts.ts';
import { prepareImageRequest } from './request.ts';
import type { GatewayServices } from '../../../../pipeline/services.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { openaiImagesRequestWantsStream } from '@floway-dev/protocols/openai-images';

export const prepareHostedImageGeneration = defineStage<
  Fields<'request.imageGeneration.canonical'>,
  Fields<'request.imageGeneration.canonical' | 'request.openaiImages.canonical' | 'serve.model' | 'ingress.openaiImages.wantsStream'>,
  Fields<'response.openaiImages.canonical' | 'response.openaiImages.streamedUsage' | 'response.http.status' | 'response.http.headers' | 'response.http.body' | 'response.usage.billable'>,
  Fields<'response.openaiImages.canonical' | 'response.openaiImages.streamedUsage' | 'response.http.status' | 'response.http.headers' | 'response.http.body' | 'response.usage.billable'>,
  Fields<'response.openaiImages.canonical' | 'response.openaiImages.streamedUsage' | 'response.http.status' | 'response.http.headers' | 'response.http.body' | 'response.usage.billable'>,
  GatewayServices
>({
  name: 'prepareHostedImageGeneration',
  through: {
    request: { needs: ['request.imageGeneration.canonical'], consumes: [], provides: ['request.openaiImages.canonical', 'serve.model', 'ingress.openaiImages.wantsStream'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.openaiImages.canonical', 'response.openaiImages.streamedUsage', 'response.http.status', 'response.http.headers', 'response.http.body', 'response.usage.billable'] },
  execute: async (facts, next, use) => {
    let request;
    try {
      request = await prepareImageRequest(facts['request.imageGeneration.canonical']);
    } catch (error) {
      use.gateway.dump?.failed(error);
      return move({
        ...facts, 'response.openaiImages.canonical': { status: 502, message: error instanceof Error ? error.message : String(error) },
        'response.openaiImages.streamedUsage': null, 'response.http.status': 502, 'response.http.headers': [],
        'response.http.body': null, 'response.usage.billable': [],
      });
    }
    return await next({
      ...facts, 'request.openaiImages.canonical': move(request),
      'serve.model': facts['request.imageGeneration.canonical'].config.model,
      'ingress.openaiImages.wantsStream': openaiImagesRequestWantsStream(request),
    });
  },
});
