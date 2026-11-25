import { gatewayFactSpace } from './facts.ts';
import { readHttpResponseBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';

export interface RequestBodyService {
  readonly requestBody: ReadableStream<Uint8Array> | null;
}

const { defineStage } = gatewayFactSpace<RequestBodyService>();

export const requestBody = defineStage({
  name: 'serve.request-body',
  through: {
    request: { needs: ['request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const raw = scope.services.requestBody;
    if (raw === null) return await scope.next(facts);
    const body = scope.createStream(({ signal }) => readHttpResponseBody(raw, signal));
    return await scope.next({ ...facts, 'request.http': move({ ...facts['request.http'], body }) });
  },
});
