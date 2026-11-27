import { createCopilotServices, type CopilotServices } from '../../src/service.ts';
import { getHeaders, type HttpRequestFact } from '@floway-dev/http';
import { asEntry, factSpace, run, type Facts, type ManagedStream, type Result } from '@floway-dev/pipeline';
import { parseAnthropicBetaHeader } from '@floway-dev/protocols/anthropic-messages';
import { stubUpstreamModel } from '@floway-dev/test-utils';
import { toUpstreamModelSnapshot, type ProtocolStreamError, type UpstreamEvent, type UpstreamModel, type UpstreamOperation, type UpstreamOutcome, type UpstreamRequestFacts } from '@floway-dev/upstream';

const { compose, defineStage } = factSpace<Facts, Facts, CopilotServices>();
interface FixtureSide {
  readonly needs: readonly string[];
  readonly provides: readonly string[];
  readonly consumes: readonly string[];
}
type Stage = ReturnType<typeof defineStage<{ request: FixtureSide; response: FixtureSide }>>;
export type StageEvent<Op extends UpstreamOperation> = UpstreamEvent<Op>;

export interface StageFixture<Op extends UpstreamOperation> {
  payload: UpstreamRequestFacts[Op];
  model?: UpstreamModel;
  headers?: Headers;
  anthropicBeta?: readonly string[];
}

export const startStages = <Op extends UpstreamOperation>(
  operation: Op,
  stage: Stage | readonly Stage[],
  fixture: StageFixture<NoInfer<Op>>,
  terminal?: (scope: { stream: (events: AsyncIterable<StageEvent<Op>> | Iterable<StageEvent<Op>>) => ManagedStream<StageEvent<Op>, ProtocolStreamError> }) => UpstreamOutcome<Op>,
) => {
  let observed: Facts | undefined;
  let answer: Facts | undefined;
  const entry: readonly string[] = ['http', 'model', operation];
  const exit: readonly string[] = [operation];
  const ending = defineStage({
    name: 'observe-wire-request',
    request: { needs: entry },
    return: { provides: exit },
    async execute(facts, scope) {
      observed = facts;
      const outcome: UpstreamOutcome<Op> = terminal === undefined ? { kind: 'error', source: 'local', error: 'Test terminal' } : terminal({
        stream: events => scope.createStream<StageEvent<Op>, ProtocolStreamError>(async function* () {
          for await (const event of events) yield { ok: true, value: event };
        }),
      });
      return { [operation]: outcome };
    },
  });
  const pipeline = compose('copilot.test', { entry, exit, stages: 'name' in stage ? [stage] : stage, ending });
  const headers = new Headers(fixture.headers);
  if (fixture.anthropicBeta?.length) headers.set('anthropic-beta', fixture.anthropicBeta.join(','));
  const http: HttpRequestFact = { url: 'https://floway.test', method: 'POST', headers: [...headers], body: null };
  const controller = new AbortController();
  const background: Promise<unknown>[] = [];
  const request = {
    http,
    model: toUpstreamModelSnapshot(fixture.model ?? stubUpstreamModel()),
    [operation]: fixture.payload,
  };
  const running = run(asEntry(pipeline), request, {
    signal: controller.signal,
    waitUntil: task => { background.push(task); },
    services: createCopilotServices({ fetcher: () => { throw new Error('Test terminal owns the response'); } }),
  });
  return {
    running,
    result: running.result.then(facts => {
      answer = facts;
      return facts[operation] as UpstreamOutcome<Op>;
    }),
    async settle() { await Promise.all(background); },
    abort() {
      controller.abort();
      if (answer !== undefined) running.discard(answer);
    },
    request() {
      if (observed === undefined) throw new Error('Test terminal was not reached');
      return { http: observed.http as HttpRequestFact, payload: observed[operation] as UpstreamRequestFacts[Op] };
    },
  };
};

export const inspectStages = async <Op extends UpstreamOperation>(
  operation: Op,
  stage: Stage | readonly Stage[],
  fixture: StageFixture<NoInfer<Op>>,
  terminal?: Parameters<typeof startStages<Op>>[3],
) => {
  const { running, result, settle, abort, request } = startStages(operation, stage, fixture, terminal);
  const items: Result<StageEvent<Op>, ProtocolStreamError>[] = [];
  let response: UpstreamOutcome<Op>;
  try {
    response = await result;
    if (response.kind === 'stream') {
      for await (const item of running.read(response.stream as ManagedStream<StageEvent<Op>, ProtocolStreamError>)) items.push(item);
    }
    await settle();
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
