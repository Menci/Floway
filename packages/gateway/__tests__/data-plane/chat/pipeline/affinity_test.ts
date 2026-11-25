import { expect, test } from 'vitest';

import { prepareChatAffinity } from '../../../../src/data-plane/chat/pipeline/affinity.ts';
import { AffinityCodec, affinityIdentityForCandidate, candidateSatisfiesAffinityIdentity, defineAffinityRequest, projectOptionalAffinityBlob } from '../../../../src/data-plane/chat/shared/affinity/index.ts';
import { gatewayFactSpace, type ServeCandidate } from '../../../../src/data-plane/pipeline/facts.ts';
import { failover } from '../../../../src/data-plane/pipeline/failover.ts';
import { responseHead } from '../../../../src/data-plane/pipeline/response.ts';
import { move, run } from '@floway-dev/pipeline';
import { formatOpenAIChatCompletionsError, type OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

const requestKey = 'request.openaiChatCompletions';
const responseKey = 'response.openaiChatCompletions';
const domain = 'test.affinity';
const { compose, defineStage } = gatewayFactSpace<{ readonly affinityCodec: () => AffinityCodec }>();

const candidate = (id: string, key: string, available = true): ServeCandidate => ({
  upstream: { id, kind: 'custom', name: id, config: {} },
  model: {
    id: 'public-model',
    kind: 'chat',
    upstreamModelId: 'native-model',
    limits: {},
    endpoints: available ? { openaiChatCompletions: {} } : {},
    opaqueBlobCompatibilityScope: { bindToUpstream: false, key },
    enabledFlags: [],
  },
});

const request = (content: string): OpenAIChatCompletionsPayloadEx => ({
  model: 'public-model',
  stream: true,
  messages: [{ role: 'user', content }],
});

const localError = (message: string) => ({
  'response.http': move(responseHead(400)),
  [responseKey]: move({ kind: 'error', source: 'local', error: formatOpenAIChatCompletionsError(400, message) } as const),
});

const createPipeline = (
  prepare: ReturnType<typeof prepareChatAffinity<'openaiChatCompletions', OpenAIChatCompletionsPayloadEx>>,
  ending: ReturnType<typeof defineStage>,
) => compose('test.chat-affinity', {
  entry: ['serve.model', 'serve.candidates', requestKey],
  exit: ['response.http', responseKey],
  stages: [failover(responseKey, () => { throw new Error('Expected the affinity decision'); }, c => c.model.endpoints.openaiChatCompletions !== undefined, prepare)],
  ending,
});

const input = (candidates: readonly ServeCandidate[], content: string) => ({
  'serve.model': 'public-model',
  'serve.candidates': move({ candidates, sawModel: true, failedUpstreams: [] }),
  [requestKey]: move(request(content)),
});

test('affinity materializes ordered request targets before the first failover attempt', async () => {
  const codec = new AffinityCodec('00'.repeat(32));
  const preferred = candidate('preferred', 'compatible-family');
  const fallback = candidate('fallback', 'compatible-family');
  const degrading = candidate('degrading', 'different-family');
  const unsupported = candidate('unsupported', 'compatible-family', false);
  const wrapped = await codec.wrap('original', affinityIdentityForCandidate(preferred), domain);
  const projected: string[] = [];
  const attempted: string[] = [];
  let analyzed = 0;
  const prepare = prepareChatAffinity('openaiChatCompletions', async (payload: OpenAIChatCompletionsPayloadEx, codec) => {
    analyzed++;
    const message = payload.messages[0];
    if (message?.role !== 'user' || typeof message.content !== 'string') throw new TypeError('Expected an affinity-bearing message');
    const decoded = await codec.unwrap(message.content, domain);
    return defineAffinityRequest([], candidate => {
      const projection = projectOptionalAffinityBlob(decoded, candidate);
      return {
        kind: 'accepted',
        degrades: projection.kind === 'remove' && projection.degrades,
        preferred: projection.preferred,
        materialize: () => {
          projected.push(candidate.upstream.id);
          const content = projection.kind === 'preserve' ? projection.value : 'removed';
          return { ...payload, messages: [{ ...message, content }] };
        },
      };
    });
  }, localError);
  const ending = defineStage({
    name: 'test.return-affinity-attempt',
    request: { needs: ['serve.candidate', requestKey] },
    return: { provides: ['response.http', responseKey] },
    async execute(facts, scope) {
      const id = facts['serve.candidate'].upstream.id;
      attempted.push(id);
      expect(projected).toEqual(['preferred', 'fallback', 'degrading']);
      expect(facts[requestKey].messages[0]).toMatchObject({ content: 'original' });
      if (id === 'preferred') return {
        'response.http': move(responseHead(429)),
        [responseKey]: move({ kind: 'error', source: 'upstream', error: { message: 'Please retry.' } } as const),
      };
      return {
        'response.http': move(responseHead(200)),
        [responseKey]: move({ kind: 'stream', stream: scope.createStream(async function* () {}) } as const),
      };
    },
  });
  const handle = run(createPipeline(prepare, ending), input([degrading, fallback, unsupported, preferred], wrapped), {
    services: { affinityCodec: () => codec },
  });
  const answer = await handle.result;
  const outcome = answer[responseKey];
  if (outcome.kind !== 'stream') throw new TypeError('Expected the compatible candidate stream');
  expect((await outcome.stream[Symbol.asyncIterator]().next()).done).toBe(true);
  await handle.done;
  expect(analyzed).toBe(1);
  expect(attempted).toEqual(['preferred', 'fallback']);
});

test('required affinity returns a local 400 before dispatch when no viable target satisfies it', async () => {
  const required = affinityIdentityForCandidate(candidate('required', 'required-family'));
  const prepare = prepareChatAffinity('openaiChatCompletions', async (payload: OpenAIChatCompletionsPayloadEx) =>
    defineAffinityRequest([required], candidate => candidateSatisfiesAffinityIdentity(candidate, required)
      ? { kind: 'accepted', degrades: false, materialize: () => payload }
      : { kind: 'rejected' }), localError);
  const ending = defineStage({
    name: 'test.unused-affinity-attempt',
    request: { needs: ['serve.candidate', requestKey] },
    return: { provides: ['response.http', responseKey] },
    async execute() { throw new Error('Candidate violating required affinity reached the pipeline'); },
  });
  const codec = new AffinityCodec('00'.repeat(32));
  const handle = run(createPipeline(prepare, ending), input([candidate('incompatible', 'different-family')], 'hello'), {
    services: { affinityCodec: () => codec },
  });
  const answer = await handle.result;
  expect(answer['response.http']).toMatchObject({ status: 400, statusText: 'Bad Request' });
  expect(answer[responseKey]).toMatchObject({
    kind: 'error',
    source: 'local',
    error: { error: { message: "Client-carried state requires unavailable target 'required/public-model'." } },
  });
  await handle.done;
});
