import type { CopilotFacts } from '../../src/pipelines/facts.ts';
import { createCopilotService, type CopilotServices } from '../../src/service.ts';
import { materializeHeaders, type HttpRequestFact } from '@floway-dev/http';
import { factSpace, move, run, type ManagedStream, type Pipeline, type Result } from '@floway-dev/pipeline';
import { toProviderModelFact, type ProtocolStreamError, type ProviderModel } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

type Protocol = 'anthropicMessages' | 'openaiChatCompletions' | 'openaiResponses';
type Request<Kind extends Protocol> = CopilotFacts[`request.${Kind}`];
type Outcome<Kind extends Protocol> = CopilotFacts[`response.${Kind}`];
type SuccessItem<Kind extends Protocol> = Extract<Outcome<Kind>, { kind: 'stream' }>['stream'] extends ManagedStream<infer Event, ProtocolStreamError> ? Event : never;

const { defineStage, compose } = factSpace<CopilotFacts, CopilotServices>();

type FactsWith<Keys extends readonly (keyof CopilotFacts)[]> =
  ReturnType<typeof compose<Keys, readonly []>> extends Pipeline<infer Input, unknown, CopilotServices> ? Input : never;

export type CopilotStage = Parameters<typeof compose>[1]['stages'][number];

type Terminal<Kind extends Protocol> =
  | { readonly stream: AsyncIterable<Result<SuccessItem<Kind>, ProtocolStreamError>> | ((signal: AbortSignal) => AsyncIterable<Result<SuccessItem<Kind>, ProtocolStreamError>>) }
  | { readonly outcome: Exclude<Outcome<Kind>, { kind: 'stream' }> };

export interface StageRequest<Kind extends Protocol> {
  payload: Request<Kind>;
  headers?: Headers;
  model?: ProviderModel;
}

export const runStage = async <Kind extends Protocol>(
  stage: CopilotStage | CopilotStage[],
  protocol: Kind,
  { payload, model, headers }: StageRequest<Kind>,
  terminal: Terminal<Kind> = { outcome: { kind: 'error', source: 'upstream', error: null } as Exclude<Outcome<Kind>, { kind: 'stream' }> },
) => {
  const rq = `request.${protocol}` as const;
  const rs = `response.${protocol}` as const;
  const entry = ['request.http', 'provider.model', 'copilot.modelId', rq] as const;
  const exit = ['response.http', 'response.modelKey', rs] as const;
  let request: { readonly payload: Request<Kind>; readonly http: HttpRequestFact } | undefined;
  const ending = defineStage({
    name: 'observe-stage',
    request: { needs: entry },
    return: { provides: exit },
    async execute(facts, scope) {
      request = { payload: (facts as unknown as Pick<CopilotFacts, typeof rq>)[rq], http: facts['request.http'] };
      const outcome = 'stream' in terminal
        ? { kind: 'stream', stream: scope.createStream(({ signal }) => typeof terminal.stream === 'function' ? terminal.stream(signal) : terminal.stream) } as const
        : terminal.outcome;
      return { 'response.http': null, 'response.modelKey': facts['copilot.modelId'], [rs]: move(outcome) } as unknown as FactsWith<typeof exit>;
    },
  });
  const stages = Array.isArray(stage) ? stage : [stage];
  const pipeline = compose('stage-test', { entry, exit, stages, ending });
  const modelFact = toProviderModelFact(model ?? stubProviderModel({ id: payload.model }));
  const started = run(pipeline, {
    'request.http': move({ url: 'https://floway.test', method: 'POST', headers: headers ? [...headers] : [], body: null }),
    'provider.model': move(modelFact),
    'copilot.modelId': modelFact.upstreamModelId,
    [rq]: move(payload),
  } as unknown as FactsWith<typeof entry>, {
    services: {
      copilot: createCopilotService(),
      fetcher: () => { throw new Error('Unexpected upstream fetch'); },
    },
  });
  const answer = await started.result;
  if (request === undefined) throw new Error('Expected the stage to reach the terminal');
  const outcome = (answer as unknown as Pick<CopilotFacts, typeof rs>)[rs];
  const stream = outcome.kind === 'stream' ? outcome.stream as ManagedStream<SuccessItem<Kind>, ProtocolStreamError> : undefined;
  if (stream === undefined) await started.done;

  return {
    payload: request.payload,
    headers: new Headers(materializeHeaders(request.http.headers)),
    outcome,
    stream,
    done: started.done,
  };
};
