import { takeHttpResponse } from '@floway-dev/http/pipeline';
import { compose, defineStage, isSecret, move, type Handed } from '@floway-dev/pipeline';
import type { AnthropicMessagesUpstreamCallOptions, ChatProviderOperation, ProviderChatServices, ProviderModel, ProviderOperationOutputs, ProviderOperationPayloads, ProviderOperationRequest, ProviderOperationResponse, ProviderPipeline, ProviderResponse, UpstreamCallOptions } from '@floway-dev/provider';
import { decodeProviderResponse } from '@floway-dev/provider';

type Frame<O extends ChatProviderOperation> = Extract<ProviderOperationOutputs[O], { kind: 'stream' }> extends { frames: AsyncIterable<infer F> } ? F : never;
type TransportFailure = { type: 'transportFailure'; error: unknown };
type Reply = ResponsesReply | StreamReply<'openaiChatCompletions'> | StreamReply<'anthropicMessages'> | CountReply | TransportFailure;
type AnyFrame = Frame<'openaiChatCompletions'> | Frame<'openaiResponses'> | Frame<'anthropicMessages'>;
type StreamReply<O extends ChatProviderOperation> = { ok: true; events: AsyncIterable<Frame<O>>; modelKey: string; headers?: Headers } | { ok: false; response: Response; modelKey: string };
type ResponsesReply = (StreamReply<'openaiResponses'> & { action: 'generate' }) | { action: 'compact'; ok: true; result: Extract<ProviderOperationOutputs['openaiResponses'], { kind: 'value' }>['body']; modelKey: string } | { action: 'compact'; ok: false; response: Response; modelKey: string };
type CountReply = { response: Response; modelKey: string };
export type StubChatProviderCall<O extends ChatProviderOperation> =
  O extends 'openaiResponses' | 'openaiResponsesCompact'
    ? (model: ProviderModel, payload: ProviderOperationPayloads[O], action: 'generate' | 'compact', signal: AbortSignal | undefined, options: UpstreamCallOptions) => Promise<ResponsesReply | TransportFailure>
    : O extends 'anthropicMessagesCountTokens'
      ? (model: ProviderModel, payload: ProviderOperationPayloads[O], signal: AbortSignal | undefined, options: AnthropicMessagesUpstreamCallOptions) => Promise<CountReply | TransportFailure>
      : O extends 'anthropicMessages'
        ? (model: ProviderModel, payload: ProviderOperationPayloads[O], signal: AbortSignal | undefined, options: AnthropicMessagesUpstreamCallOptions) => Promise<StreamReply<O> | TransportFailure>
        : (model: ProviderModel, payload: ProviderOperationPayloads[O], signal: AbortSignal | undefined, options: UpstreamCallOptions) => Promise<StreamReply<O> | TransportFailure>;

const responseFromFrames = (operation: ChatProviderOperation, frames: AsyncIterable<AnyFrame>, sourceHeaders: Headers | undefined): Response => {
  const iterator = frames[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull: async controller => {
      try {
        for (;;) {
          const item = await iterator.next();
          if (item.done) { controller.close(); return; }
          const frame = item.value;
          if (frame.type === 'done') {
            if (operation === 'anthropicMessages') continue;
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            return;
          }
          const eventName = operation === 'openaiChatCompletions' ? '' : `event: ${(frame.event as { type: string }).type}\n`;
          controller.enqueue(encoder.encode(`${eventName}data: ${JSON.stringify(frame.event)}\n\n`));
          return;
        }
      } catch (error) { controller.error(error); }
    },
    cancel: async () => { await iterator.return?.(); },
  });
  const headers = new Headers(sourceHeaders);
  headers.set('content-type', 'text/event-stream');
  return new Response(body, { headers });
};

export const stubChatProviderPipeline = <O extends ChatProviderOperation>(operation: O, call: StubChatProviderCall<O>): ProviderPipeline<O> => {
  type Entry = ProviderOperationRequest<O> & { 'request.provider.anthropicBeta': readonly string[] };
  type Ready = Entry & ProviderResponse & { 'request.provider.responsesAction': 'generate' | 'compact'; 'response.provider.responsesAction': 'generate' | 'compact' };
  const invoke = defineStage<Entry, Ready, ProviderOperationResponse<O>, ProviderOperationResponse<O>, ProviderChatServices>({
    name: `stubProviderInvoke${operation}`,
    through: {
      request: { needs: [...(operation === 'anthropicMessages' || operation === 'anthropicMessagesCountTokens' ? ['request.provider.anthropicBeta' as const] : []), 'request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers'], consumes: [], provides: ['request.provider.responsesAction', 'response.provider.responsesAction', 'response.http.exchange', 'response.http.body', 'response.provider.called', 'response.provider.previousCalls', 'response.provider.modelKey'] },
      response: { needs: [], consumes: [], provides: [] },
    },
    execute: async (facts, next, use) => {
      const modelFacts = facts['request.provider.model'];
      const model: ProviderModel = { ...modelFacts, enabledFlags: new Set(modelFacts.enabledFlags) };
      const httpCall = use.httpCall(facts['request.http.callId']);
      const options: AnthropicMessagesUpstreamCallOptions = { ...httpCall, headers: new Headers(facts['request.http.headers'].map(([name, value]): [string, string] => [name, isSecret(value) ? value.reveal() : value])), anthropicBeta: facts['request.provider.anthropicBeta'] };
      let reply: Reply;
      if (operation === 'openaiResponses' || operation === 'openaiResponsesCompact') {
        reply = await httpCall.wrapUpstreamCall(() => (call as StubChatProviderCall<'openaiResponses'>)(model, facts['request.provider.payload'] as ProviderOperationPayloads['openaiResponses'], operation === 'openaiResponsesCompact' ? 'compact' : 'generate', httpCall.signal, options));
      } else {
        reply = await httpCall.wrapUpstreamCall(() => (call as unknown as (model: ProviderModel, payload: unknown, signal: AbortSignal | undefined, options: AnthropicMessagesUpstreamCallOptions) => Promise<Reply>)(model, facts['request.provider.payload'] as ProviderOperationPayloads['anthropicMessages'], httpCall.signal, options));
      }
      if ('type' in reply) return move({ ...await next(move({ ...facts, 'request.provider.responsesAction': operation === 'openaiResponsesCompact' ? 'compact' : 'generate', 'response.provider.responsesAction': operation === 'openaiResponsesCompact' ? 'compact' : 'generate', 'response.http.exchange': reply, 'response.http.body': null, 'response.provider.called': false, 'response.provider.previousCalls': [], 'response.provider.modelKey': model.id }) as Ready & Record<string, unknown>) }) as Handed<ProviderOperationResponse<O>>;
      const response = 'response' in reply ? reply.response : 'events' in reply
        ? responseFromFrames(operation, reply.events, reply.headers)
        : Response.json(reply.result);
      const exchange = takeHttpResponse(response);
      return move({ ...await next(move({ ...facts, 'request.provider.responsesAction': 'action' in reply ? reply.action : operation === 'openaiResponsesCompact' ? 'compact' : 'generate', 'response.provider.responsesAction': 'action' in reply ? reply.action : operation === 'openaiResponsesCompact' ? 'compact' : 'generate', 'response.http.exchange': exchange, 'response.http.body': exchange.body, 'response.provider.called': true, 'response.provider.previousCalls': [], 'response.provider.modelKey': reply.modelKey }) as Ready & Record<string, unknown>) }) as Handed<ProviderOperationResponse<O>>;
    },
  });
  const reply = defineStage<Ready, ProviderResponse & { 'response.provider.responsesAction': 'generate' | 'compact' }>({
    name: 'stubProviderReply',
    return: { provides: ['response.provider.responsesAction', 'response.http.exchange', 'response.http.body', 'response.provider.called', 'response.provider.previousCalls', 'response.provider.modelKey'] },
    execute: async facts => move({ ...facts }) as Ready & Record<string, unknown>,
  });
  return compose<ProviderOperationRequest<O>, ProviderOperationResponse<O>>(`stub.${operation}`, [invoke, decodeProviderResponse(operation), reply]);
};
