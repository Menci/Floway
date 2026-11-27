import { servePipelineHttp, type HttpPanicPresentation } from './pipeline-http.ts';
import { readRequestBody } from './request-body.ts';
import { openDumpAccumulator } from '../../dump/accumulator.ts';
import { apiKeyFromContext, userFromContext, type AuthedContext } from '../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { createGatewayServices, type GatewayServices } from '../pipeline/services.ts';
import type { HttpRequestFact, HttpResponseFact } from '@floway-dev/http';
import type { Entry } from '@floway-dev/pipeline';

interface HttpIngressFacts {
  http: HttpRequestFact;
  'serve.startedAt': number;
}

interface HttpIngressAnswer {
  http: HttpResponseFact | null;
}

export const pipelineHttpHandlerWithFacts = <Input, Output extends HttpIngressAnswer>(
  entry: Entry<Input, Output, GatewayServices>,
  project: (facts: HttpIngressFacts) => NoInfer<Input>,
  panicPresentation?: HttpPanicPresentation,
) => async (c: AuthedContext): Promise<Response> => {
  const startedAt = Date.now();
  const request = c.req.raw;
  const apiKey = apiKeyFromContext(c);
  const subject = userFromContext(c);
  const waitUntil = backgroundSchedulerFromContext(c);
  const body = await readRequestBody(c);
  const dump = openDumpAccumulator(c, request.method, apiKey, body, waitUntil, true);
  const services = createGatewayServices({ apiKey, subject, runtimeLocation: getRuntimeLocation(request), dump });
  return await servePipelineHttp(entry, project({
    http: {
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body: request.body === null ? null : body.bytes,
    },
    'serve.startedAt': startedAt,
  }), { services, signal: request.signal, waitUntil, dump, panicPresentation });
};

export const pipelineHttpHandler = <Output extends HttpIngressAnswer>(entry: Entry<HttpIngressFacts, Output, GatewayServices>, panicPresentation?: HttpPanicPresentation) =>
  pipelineHttpHandlerWithFacts(entry, facts => facts, panicPresentation);
