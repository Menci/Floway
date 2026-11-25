import type { GatewayHttpInput, GatewayHttpOutput } from './facts.ts';
import { openPipelineRecorder, type PipelineRecorder } from './recorder.ts';
import type { RequestBodyService } from './request-body.ts';
import { writeHttpResponse } from './response.ts';
import { isFlowayAuthHeader } from './strip-floway-auth.ts';
import { apiKeyFromContext, effectiveUpstreamIdsFromContext, userFromContext, type AuthedContext } from '../../middleware/auth.ts';
import { internalErrorResponse } from '../../middleware/internal-error-response.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { HttpHeaders } from '@floway-dev/http';
import { move, run, Secret, type Pipeline } from '@floway-dev/pipeline';

export interface GatewayHostServicesInput extends RequestBodyService {
  readonly runtimeLocation: string;
}

export const startPipeline = <I, O, S>(
  pipeline: Pipeline<I, O, S>,
  facts: NoInfer<I>,
  services: NoInfer<S>,
  clientSignal: AbortSignal,
  recorder: PipelineRecorder | null,
) => {
  const root = new AbortController();
  const abort = (): void => { root.abort(clientSignal.reason); };
  if (clientSignal.aborted) abort();
  else clientSignal.addEventListener('abort', abort, { once: true });

  try {
    const { result, done } = run(pipeline, facts, {
      services,
      signal: root.signal,
      ...(recorder && { events: recorder.event }),
    });
    const settled = done.finally(() => { clientSignal.removeEventListener('abort', abort); });
    return {
      root,
      result,
      done: recorder === null ? settled : finishRecording(settled, recorder),
    };
  } catch (error) {
    clientSignal.removeEventListener('abort', abort);
    root.abort(error);
    throw error;
  }
};

const finishRecording = (done: Promise<void>, recorder: PipelineRecorder): Promise<void> => done.then(
  async () => { await recorder.finish(); },
  async pipelineError => {
    try {
      await recorder.finish();
    } catch (recorderError) {
      throw new AggregateError([pipelineError, recorderError], 'The data-plane pipeline and its recorder failed');
    }
    throw pipelineError;
  },
);

const initialHttpFacts = (c: AuthedContext): GatewayHttpInput => {
  const { id: apiKeyId, randomizeUpstreams } = apiKeyFromContext(c);
  const { id, isAdmin } = userFromContext(c);
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const { method, url: rawUrl, headers: inbound } = c.req.raw;
  const url = new URL(rawUrl);
  if (url.searchParams.has('key')) url.searchParams.delete('key');
  const headers: HttpHeaders = [...inbound].map(([name, value]) => [name, isFlowayAuthHeader(name) ? Secret.from(value) : value]);

  return {
    'request.http': move({ method, url: url.href, headers, body: null }),
    'request.auth.apiKeyId': apiKeyId,
    'request.auth.user': move({ id, isAdmin }),
    'request.auth.upstreamIds': upstreamIds === null ? null : move([...upstreamIds]),
    'request.auth.randomizeUpstreams': randomizeUpstreams,
  };
};

export const servePipeline = async <S extends RequestBodyService>(
  c: AuthedContext,
  pipeline: Pipeline<GatewayHttpInput, GatewayHttpOutput, S>,
  createServices: (input: GatewayHostServicesInput) => Promise<NoInfer<S>>,
): Promise<Response> => {
  const facts = initialHttpFacts(c);
  const request = c.req.raw;
  const services = await createServices({ requestBody: request.body, runtimeLocation: getRuntimeLocation(request) });
  const schedule = backgroundSchedulerFromContext(c);
  const recorder = openPipelineRecorder(c, facts['request.auth.apiKeyId']);
  const handle = startPipeline(pipeline, facts, services, request.signal, recorder);
  schedule(handle.done);

  try {
    const { 'response.http': http } = await handle.result;
    if (http === null) throw new TypeError('The ingress pipeline returned no HTTP response');
    return writeHttpResponse(http, handle.root);
  } catch (error) {
    handle.root.abort(error);
    return internalErrorResponse(error instanceof Error ? error : new Error('The data-plane pipeline panicked', { cause: error }), c);
  }
};
