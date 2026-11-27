import { applyOpenAIResponsesCollaboration } from '../../../../../src/data-plane/chat/openai-responses/pipeline/collaboration.ts';
import { openAIResponsesHostedTools } from '../../../../../src/data-plane/chat/openai-responses/pipeline/hosted-tools.ts';
import { compose, defineStage, type ChatOperation } from '../../../../../src/data-plane/chat/pipeline/facts.ts';
import type { GatewayServices } from '../../../../../src/data-plane/pipeline/services.ts';
import { candidateFor, hostFor } from '../../../pipeline/fixtures.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import { asEntry, run } from '@floway-dev/pipeline';
import type { JsonObject, ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { FlagId, ProtocolError, ProtocolStreamError } from '@floway-dev/upstream';

export type Frame = ProtocolFrame<OpenAIResponsesStreamEventEx>;
export type ScriptedResponsesTurn = { kind: 'stream'; events: AsyncIterable<Frame> } | { kind: 'error'; error: ProtocolError; http: HttpResponseFact | null };

export const responsesTurn = (events: AsyncIterable<Frame>): ScriptedResponsesTurn => ({ kind: 'stream', events });

type ScriptedResponsesOptions = {
  payload: CanonicalOpenAIResponsesPayload;
  target: ChatOperation;
  flags?: Iterable<FlagId>;
  services: GatewayServices;
  signal?: AbortSignal;
  stages?: 'hosted-tools' | 'collaboration' | 'collaboration-and-hosted-tools';
  next(payload: CanonicalOpenAIResponsesPayload): Promise<ScriptedResponsesTurn>;
};

export const runScriptedResponses = async (options: ScriptedResponsesOptions): Promise<ScriptedResponsesTurn> => {
  const ending = defineStage({
    name: 'script-responses-provider',
    request: { needs: ['openaiResponses', 'http', 'model', 'chat.target'] },
    return: { provides: ['http', 'openaiResponses', 'usage?', 'usageModelKey?'] },
    async execute({ openaiResponses }, scope) {
      const step = await options.next(openaiResponses);
      if (step.kind === 'error') return { http: step.http, openaiResponses: step.error };
      const stream = scope.createStream<OpenAIResponsesStreamEventEx, ProtocolStreamError>(async function* () {
        let notification: JsonObject | undefined;
        for await (const frame of step.events) {
          if (frame.type !== 'event') continue;
          if (frame.event.type === 'error') {
            notification = { ...frame.event };
            continue;
          }
          if (frame.event.type === 'response.failed') {
            const event = { ...(notification === undefined ? {} : { notification }), failed: frame.event };
            yield { ok: false, error: { kind: 'protocol', cause: new Error('Scripted upstream failure'), event } };
            return;
          }
          if (notification === undefined) yield { ok: true, value: frame.event };
        }
        if (notification !== undefined) yield { ok: false, error: { kind: 'protocol', cause: new Error('Scripted upstream failure'), event: { notification } } };
      });
      return { http: null, openaiResponses: { kind: 'stream', stream } };
    },
  });
  const stages = options.stages === 'collaboration-and-hosted-tools'
    ? [applyOpenAIResponsesCollaboration, openAIResponsesHostedTools] as const
    : options.stages === 'collaboration' ? [applyOpenAIResponsesCollaboration] as const : [openAIResponsesHostedTools] as const;
  const entry = asEntry(compose('script-responses-test', {
    entry: ['openaiResponses', 'http', 'model', 'chat.target'],
    exit: ['http', 'openaiResponses', 'usage?', 'usageModelKey?'],
    stages,
    ending,
  }));
  const { model } = candidateFor('custom');
  const host = hostFor(options.services);
  const execution = run(entry, {
    http: { url: 'https://floway.test/v1/responses', headers: [], method: 'POST', body: null },
    model: { ...model, enabledFlags: [...options.flags ?? []] },
    'chat.target': options.target,
    openaiResponses: options.payload,
  }, {
    ...host.options,
    signal: options.signal === undefined ? host.controller.signal : AbortSignal.any([options.signal, host.controller.signal]),
  });
  const answer = await execution.result;
  const dispose = async () => {
    host.controller.abort();
    execution.discard(answer);
    await host.settle();
    if (host.errors.length > 0) throw new AggregateError(host.errors, 'Responses fixture background work');
  };
  const outcome = answer.openaiResponses;
  if (outcome.kind === 'error') {
    await dispose();
    return { kind: 'error', error: outcome, http: answer.http };
  }
  if (outcome.kind !== 'stream') {
    await dispose();
    throw new Error('Expected the Responses fixture to return a stream');
  }
  const events = async function* (): AsyncGenerator<Frame> {
    try {
      for await (const item of execution.read(outcome.stream)) {
        if (!item.ok) {
          const error = item.error;
          if (error.kind !== 'protocol' || error.event === undefined) throw error.cause;
          for (const event of [error.event.notification, error.event.failed]) {
            if (event !== undefined) yield { type: 'event', event: event as OpenAIResponsesStreamEventEx };
          }
          if (error.event.notification === undefined && error.event.failed === undefined) throw error.cause;
        } else {
          yield { type: 'event', event: item.value };
        }
      }
    } finally {
      await dispose();
    }
  };
  return responsesTurn(events());
};
