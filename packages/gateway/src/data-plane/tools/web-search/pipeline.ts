import { fetchPageAndRecordUsage } from './fetch-page.ts';
import { runWebSearchAndRecordUsage } from './search.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { factSpace, move, type Pipeline, type Result } from '@floway-dev/pipeline';

interface Runner {
  readonly run: <I, O>(pipeline: Pipeline<I, O, GatewayServices>, facts: NoInfer<I>) => Promise<O>;
}

const backendCall = async <Request extends { signal?: AbortSignal | undefined }, Output>(
  runner: Runner,
  operation: 'search' | 'fetch-page',
  args: { readonly keyId: string; readonly request: Request },
  execute: (request: Request, keyId: string) => Promise<Output>,
): Promise<Output> => {
  const { compose, defineStage } = factSpace<{
    readonly 'request.auth.apiKeyId': string;
    readonly 'request.webSearch': Omit<Request, 'signal'>;
    readonly 'response.webSearch': Result<Output, unknown>;
  }, GatewayServices>();
  const entry = ['request.webSearch', 'request.auth.apiKeyId'] as const;
  const exit = ['response.webSearch'] as const;
  const name = `webSearch.${operation}`;
  const pipeline = compose(name, {
    entry,
    exit,
    stages: [],
    ending: defineStage({
      name: `${name}.call`,
      request: { needs: entry },
      return: { provides: exit },
      async execute(facts, scope) {
        let response: Result<Output, unknown>;
        try {
          response = {
            ok: true,
            value: await execute({ ...facts['request.webSearch'], signal: scope.signal } as Request, facts['request.auth.apiKeyId']),
          };
        } catch (error) {
          response = { ok: false, error };
        }
        return { 'response.webSearch': move(response) };
      },
    }),
  });
  const { signal: _signal, ...request } = args.request;
  const answer = await runner.run(pipeline, { 'request.webSearch': move(request), 'request.auth.apiKeyId': args.keyId });
  const response = answer['response.webSearch'];
  if (!response.ok) throw response.error;
  return response.value;
};

export const runWebSearchSubrequest = (runner: Runner, args: Parameters<typeof runWebSearchAndRecordUsage>[0]) =>
  backendCall(runner, 'search', args, (request, keyId) => runWebSearchAndRecordUsage({ ...args, request, keyId }));

export const runWebSearchFetchPageSubrequest = (runner: Runner, args: Parameters<typeof fetchPageAndRecordUsage>[0]) =>
  backendCall(runner, 'fetch-page', args, (request, keyId) => fetchPageAndRecordUsage({ ...args, request, keyId }));
