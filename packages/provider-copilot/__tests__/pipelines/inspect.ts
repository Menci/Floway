import { createCopilotService, type CopilotServices } from '../../src/service.ts';
import { getHeaders, type HttpRequestFact } from '@floway-dev/http';
import { factSpace, run, type Facts, type ManagedStream, type Result } from '@floway-dev/pipeline';
import { parseAnthropicBetaHeader } from '@floway-dev/protocols/anthropic-messages';
import { toProviderModelFact, type GatewayFacts, type ProtocolStreamError, type ProviderModel, type ProviderOperation } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const { compose, defineStage } = factSpace<Facts, CopilotServices>();
type Stage = ReturnType<typeof defineStage>;
type StageOutcome<Op extends ProviderOperation> = GatewayFacts[`response.${Op}`];
export type StageEvent<Op extends ProviderOperation> = Extract<StageOutcome<Op>, { kind: 'stream' }> extends {
  stream: ManagedStream<infer Event, ProtocolStreamError>;
} ? Event : never;

export interface StageFixture<Op extends ProviderOperation> {
  payload: GatewayFacts[`request.${Op}`];
  model?: ProviderModel;
  headers?: Headers;
  anthropicBeta?: readonly string[];
}

export const startStages = <Op extends ProviderOperation>(
  operation: Op,
  stage: Stage | readonly Stage[],
  fixture: StageFixture<NoInfer<Op>>,
  terminal: ((scope: { stream: (events: AsyncIterable<StageEvent<Op>> | Iterable<StageEvent<Op>>) => ManagedStream<StageEvent<Op>, ProtocolStreamError> }) => StageOutcome<Op>) | undefined = undefined,
) => {
  const payloadKey = `request.${operation}` as const;
  const responseKey = `response.${operation}` as const;
  let observed: Facts | undefined;
  const entry: readonly string[] = ['request.http', 'provider.model', payloadKey];
  const exit: readonly string[] = [responseKey];
  const ending = defineStage({
    name: 'observe-wire-request',
    request: { needs: entry },
    return: { provides: exit },
    async execute(facts, scope) {
      observed = facts;
      const answer: unknown = terminal === undefined ? { kind: 'error', source: 'local', error: 'Test terminal' } : terminal({
        stream: events => scope.createStream<StageEvent<Op>, ProtocolStreamError>(async function* () {
          for await (const event of events) yield { ok: true, value: event };
        }),
      });
      return { [responseKey]: answer };
    },
  });
  const pipeline = compose('copilot.test', { entry, exit, stages: 'name' in stage ? [stage] : stage, ending });
  const headers = new Headers(fixture.headers);
  if (fixture.anthropicBeta?.length) headers.set('anthropic-beta', fixture.anthropicBeta.join(','));
  const http: HttpRequestFact = { url: 'https://floway.test', method: 'POST', headers: [...headers], body: null };
  const controller = new AbortController();
  const running = run(pipeline, {
    'request.http': http,
    'provider.model': toProviderModelFact(fixture.model ?? stubProviderModel()),
    [payloadKey]: fixture.payload,
  }, {
    signal: controller.signal,
    waitUntil() {},
    services: {
      fetcher: () => { throw new Error('Test terminal owns the response'); },
      copilot: createCopilotService(),
    },
  });
  return {
    running,
    result: running.result.then(facts => facts[responseKey] as StageOutcome<Op>),
    abort: () => { controller.abort(); },
    request() {
      if (observed === undefined) throw new Error('Test terminal was not reached');
      return { http: observed['request.http'] as HttpRequestFact, payload: observed[payloadKey] as GatewayFacts[typeof payloadKey] };
    },
  };
};

export const inspectStages = async <Op extends ProviderOperation>(
  operation: Op,
  stage: Stage | readonly Stage[],
  fixture: StageFixture<NoInfer<Op>>,
  terminal?: Parameters<typeof startStages<Op>>[3],
) => {
  const { running, result, abort, request } = startStages(operation, stage, fixture, terminal);
  const items: Result<StageEvent<Op>, ProtocolStreamError>[] = [];
  let response: StageOutcome<Op>;
  try {
    response = await result;
    if (response.kind === 'stream') {
      for await (const item of running.read(response.stream as ManagedStream<StageEvent<Op>, ProtocolStreamError>)) items.push(item);
    }
    await running.done;
  } finally {
    abort();
  }
  const { http, payload } = request();
  const observedHeaders = new Headers(http.headers.map(([name, value]) => {
    if (typeof value !== 'string') throw new TypeError(`Unexpected secret header ${name}`);
    return [name, value];
  }));
  const anthropicBeta = getHeaders(http.headers, 'anthropic-beta').flatMap(value =>
    typeof value === 'string' ? parseAnthropicBetaHeader(value) : []);
  return { payload, headers: observedHeaders, anthropicBeta, response, items };
};
