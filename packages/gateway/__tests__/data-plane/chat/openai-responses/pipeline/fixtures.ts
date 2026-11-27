import { lowerOpenAIResponsesAgentMessage } from '../../../../../src/data-plane/chat/openai-responses/pipeline/agent-message.ts';
import { normalizeOpenAIResponsesCachedTokens } from '../../../../../src/data-plane/chat/openai-responses/pipeline/cached-token-usage.ts';
import { normalizeOpenAIResponsesEmptyToolsToolChoice } from '../../../../../src/data-plane/chat/openai-responses/pipeline/empty-tools-tool-choice.ts';
import { nullOpenAIResponsesUnresolvedFunctionCallNamespace } from '../../../../../src/data-plane/chat/openai-responses/pipeline/function-call-namespace.ts';
import { stripOpenAIResponsesPromptCacheKey } from '../../../../../src/data-plane/chat/openai-responses/pipeline/prompt-cache-key.ts';
import { disableOpenAIResponsesReasoningOnForcedToolChoice } from '../../../../../src/data-plane/chat/openai-responses/pipeline/reasoning-tool-choice.ts';
import { applyOpenAIResponsesRoleCompatibility } from '../../../../../src/data-plane/chat/openai-responses/pipeline/role-compatibility.ts';
import { lowerOpenAIResponsesStandaloneToolOutput } from '../../../../../src/data-plane/chat/openai-responses/pipeline/standalone-tool-output.ts';
import { forceOpenAIResponsesStoreFalse } from '../../../../../src/data-plane/chat/openai-responses/pipeline/store-false.ts';
import { compose, defineStage, type ChatOperation } from '../../../../../src/data-plane/chat/pipeline/facts.ts';
import { createGatewayServices } from '../../../../../src/data-plane/pipeline/services.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { candidateFor, hostFor } from '../../../pipeline/fixtures.ts';
import { asEntry, run } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { FlagId, ProtocolStreamError } from '@floway-dev/upstream';

export const responsesTestServices = (id = 'key') => createGatewayServices({
  apiKey: { id, serverSecret: 'ab'.repeat(32), openaiResponsesRetentionSeconds: 0, upstreamIds: null, randomizeUpstreams: false },
  subject: { id: 1, isAdmin: false },
  runtimeLocation: 'TEST',
  dump: null,
});

export const inspectResponsesShaping = async (
  payload: CanonicalOpenAIResponsesPayload,
  flags: Iterable<FlagId>,
  target: ChatOperation = 'openaiResponses',
  events: readonly OpenAIResponsesStreamEventEx[] = [],
) => {
  initRepo(new InMemoryRepo());
  let dialPayload: CanonicalOpenAIResponsesPayload | undefined;
  const ending = defineStage({
    name: 'capture-responses-shaping',
    request: { needs: ['openaiResponses'] },
    return: { provides: ['http', 'openaiResponses'] },
    async execute({ openaiResponses }, scope) {
      dialPayload = openaiResponses;
      const stream = scope.createStream<OpenAIResponsesStreamEventEx, ProtocolStreamError>(async function* () {
        for (const event of events) yield { ok: true, value: event };
      });
      return { http: null, openaiResponses: { kind: 'stream', stream } };
    },
  });
  const entry = asEntry(compose('responses-shaping-test', {
    entry: ['openaiResponses', 'model', 'upstream', 'chat.target'],
    exit: ['http', 'openaiResponses'],
    stages: [
      lowerOpenAIResponsesAgentMessage, lowerOpenAIResponsesStandaloneToolOutput, nullOpenAIResponsesUnresolvedFunctionCallNamespace,
      disableOpenAIResponsesReasoningOnForcedToolChoice, normalizeOpenAIResponsesEmptyToolsToolChoice,
      applyOpenAIResponsesRoleCompatibility, stripOpenAIResponsesPromptCacheKey, forceOpenAIResponsesStoreFalse,
      normalizeOpenAIResponsesCachedTokens,
    ],
    ending,
  }));
  const { model, upstream } = candidateFor('custom');
  const host = hostFor(responsesTestServices());
  const execution = run(entry, { upstream, model: { ...model, enabledFlags: [...flags] }, openaiResponses: payload, 'chat.target': target }, host.options);
  const answer = await execution.result;
  try {
    const outcome = answer.openaiResponses;
    if (outcome.kind === 'error') return { error: outcome.error, status: answer.http?.status };
    if (outcome.kind !== 'stream' || dialPayload === undefined) throw new Error('Expected the Responses shaping fixture to dial');
    const output: OpenAIResponsesStreamEventEx[] = [];
    for await (const item of execution.read(outcome.stream)) {
      if (!item.ok) throw item.error.cause;
      output.push(item.value);
    }
    return { payload: dialPayload, events: output };
  } finally {
    host.controller.abort();
    execution.discard(answer);
    await host.settle();
    if (host.errors.length > 0) throw new AggregateError(host.errors, 'Responses fixture background work');
  }
};
