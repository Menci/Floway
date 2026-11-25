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

type TestFacts = CopilotFacts & {
  readonly 'test.request': { readonly payload: unknown; readonly http: HttpRequestFact };
};

const { defineStage, compose } = factSpace<TestFacts, CopilotServices>();

type FactsWith<Keys extends readonly (keyof TestFacts)[]> =
  ReturnType<typeof compose<Keys, readonly []>> extends Pipeline<infer Input, unknown, CopilotServices> ? Input : never;

export type CopilotStage = Parameters<typeof compose>[1]['stages'][number];

type Terminal<Kind extends Protocol> =
  | { readonly stream: AsyncIterable<Result<SuccessItem<Kind>, ProtocolStreamError>> }
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
  const entry = ['request.http', 'provider.model', rq] as const;
  const exit = ['test.request', rs] as const;
  const ending = defineStage({
    name: 'observe-stage',
    request: { needs: entry },
    return: { provides: exit },
    async execute(facts, scope) {
      const request = move({ payload: (facts as unknown as Pick<TestFacts, typeof rq>)[rq], http: facts['request.http'] });
      const outcome = 'stream' in terminal
        ? { kind: 'stream', stream: scope.createStream(() => terminal.stream) } as const
        : terminal.outcome;
      return { 'test.request': request, [rs]: move(outcome) } as unknown as FactsWith<typeof exit>;
    },
  });
  const stages = Array.isArray(stage) ? stage : [stage];
  const pipeline = compose('stage-test', { entry, exit, stages, ending });
  const started = run(pipeline, {
    'request.http': move({ url: 'https://floway.test', method: 'POST', headers: headers ? [...headers] : [], body: null }),
    'provider.model': move(toProviderModelFact(model ?? stubProviderModel({ id: payload.model }))),
    [rq]: move(payload),
  } as unknown as FactsWith<typeof entry>, {
    services: {
      copilot: createCopilotService(),
      fetcher: () => { throw new Error('Unexpected upstream fetch'); },
    },
  });
  const answer = await started.result;
  const request = answer['test.request'];
  const outcome = (answer as unknown as Pick<TestFacts, typeof rs>)[rs];
  const stream = outcome.kind === 'stream' ? outcome.stream as ManagedStream<SuccessItem<Kind>, ProtocolStreamError> : undefined;
  if (stream === undefined) await started.done;

  return {
    payload: request.payload as Request<Kind>,
    headers: new Headers(materializeHeaders(request.http.headers)),
    outcome,
    stream,
    done: started.done,
  };
};
