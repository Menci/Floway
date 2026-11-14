import { takeHttpResponse, type HttpExchange, type HttpHeaders } from '@floway-dev/http/pipeline';
import { compose, defineStage, isSecret, move, run, type Stage } from '@floway-dev/pipeline';
import { providerModelFacts, type ProviderModel, type ProviderOperationOutputs, type ProviderOperationPayloads, type ProviderProtocolFailure } from '@floway-dev/provider';

type ProtocolFrame<T> = Extract<ProviderOperationOutputs['openaiChatCompletions'], { kind: 'stream' }>['frames'] extends AsyncIterable<infer F>
  ? F extends { type: 'event'; event: unknown } ? Omit<F, 'event'> & { event: T } : F
  : never;
type OpenAIChatCompletionsPayload = ProviderOperationPayloads['openaiChatCompletions'] & { model: string };
type CanonicalOpenAIResponsesPayload = ProviderOperationPayloads['openaiResponses'] & { model: string };
type AnthropicMessagesPayload = ProviderOperationPayloads['anthropicMessages'] & { model: string };

export interface ProviderStageProbe<P extends object> {
  payload: P;
  headers: Headers;
  model: ProviderModel;
  action?: 'generate' | 'compact';
  anthropicBeta?: readonly string[];
}
export type OpenAIChatCompletionsProbe = ProviderStageProbe<OpenAIChatCompletionsPayload>;
export type OpenAIResponsesProbe = ProviderStageProbe<CanonicalOpenAIResponsesPayload> & { action: 'generate' | 'compact' };
export type AnthropicMessagesProbe = ProviderStageProbe<AnthropicMessagesPayload> & { anthropicBeta: readonly string[] };

type Output = { kind: 'stream'; frames: AsyncIterable<ProtocolFrame<unknown>> } | { kind: 'value'; body: unknown } | ProviderProtocolFailure | null;
type Facts = Record<string, unknown> & { 'response.http.exchange': HttpExchange; 'response.provider.output': Output };

export const applyProviderStage = async <P extends object, R>(stage: Stage, probe: ProviderStageProbe<P>, reply: () => Promise<R>, extraFacts: Readonly<Record<string, unknown>> = {}): Promise<R> => {
  let template: unknown;
  const terminal = defineStage<Record<string, unknown>, Facts>({
    name: 'testProtocolReply',
    return: { provides: ['response.http.exchange', 'response.http.body', 'response.provider.called', 'response.provider.previousCalls', 'response.provider.modelKey', 'response.provider.output'] },
    execute: async facts => {
      probe.payload = facts['request.provider.payload'] as P;
      probe.headers = new Headers((facts['request.http.headers'] as HttpHeaders).map(([name, value]): [string, string] => [name, isSecret(value) ? value.reveal() : value]));
      if ('request.provider.anthropicBeta' in facts) probe.anthropicBeta = facts['request.provider.anthropicBeta'] as readonly string[];
      template = await reply();
      const value = typeof template === 'object' && template !== null ? template as Record<string, unknown> : null;
      let exchange: HttpExchange = { type: 'response', status: 200, statusText: 'OK', headers: [], body: null };
      let output: Output = null;
      if (value !== null) {
        if (value.type === 'events' || value.ok === true && value.action !== 'compact') output = { kind: 'stream', frames: value.events as AsyncIterable<ProtocolFrame<unknown>> };
        else if (value.ok === true && value.action === 'compact') output = { kind: 'value', body: value.result };
        else if (value.response instanceof Response) exchange = takeHttpResponse(value.response);
        else if (value.type === 'api-error') exchange = takeHttpResponse(new Response(value.body as Uint8Array<ArrayBuffer>, { status: value.status as number, headers: value.headers as Headers }));
      }
      return move({ ...facts, 'response.http.exchange': exchange, 'response.http.body': exchange.body, 'response.provider.called': true, 'response.provider.previousCalls': [], 'response.provider.modelKey': probe.model.id, 'response.provider.output': output });
    },
  });
  const executed = await run(compose<Record<string, unknown>, Facts>('testProviderStage', [stage, terminal]), move({
    'request.provider.payload': probe.payload,
    'request.provider.model': providerModelFacts(probe.model),
    'request.provider.modelKey': probe.model.id,
    'request.http.headers': [...probe.headers],
    'request.http.callId': 0,
    ...(probe.action === undefined ? {} : { 'request.provider.responsesAction': probe.action }),
    ...(probe.anthropicBeta === undefined ? {} : { 'request.provider.anthropicBeta': probe.anthropicBeta }),
    ...extraFacts,
  }), { recordProtocolFrames: <T extends ProtocolFrame<unknown>>(frames: AsyncIterable<T>): AsyncIterable<T> => frames });
  const output = executed.facts['response.provider.output'];
  const value = typeof template === 'object' && template !== null ? template as Record<string, unknown> : null;
  let result: unknown = template;
  if (value !== null && output !== null) {
    if ('kind' in output) result = output.kind === 'stream' ? { ...value, events: output.frames } : { ...value, result: output.body };
    else if (value.type === 'api-error') result = { ...value, status: output.status, headers: new Headers({ 'content-type': 'application/json' }), body: new TextEncoder().encode(JSON.stringify(output.body)) };
  }
  await executed.drain();
  return result as R;
};
