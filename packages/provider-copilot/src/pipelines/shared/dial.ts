import { defineCopilotStage } from '../facts.ts';
import { setHeader, type HttpRequestFact, type HttpStreamError } from '@floway-dev/http';
import { httpDialError, type FormatProtocolError, type GatewayFacts, type ProviderOperation } from '@floway-dev/provider';

interface WireRequest {
  path: string;
  body: Uint8Array;
  contentType: string;
  modelId: string;
}

type Serialize<Op extends ProviderOperation> = (payload: GatewayFacts[`request.${Op}`]) => WireRequest | Promise<WireRequest>;
type SerializeDecision = (payload: GatewayFacts['request.decision'], model: GatewayFacts['provider.model']) => WireRequest;

export const jsonRequest = (path: string, value: object): WireRequest => {
  if (!('model' in value) || typeof value.model !== 'string') throw new TypeError('Copilot JSON request requires a wire model id');
  return {
    path,
    body: new TextEncoder().encode(JSON.stringify(value)),
    contentType: 'application/json',
    modelId: value.model,
  };
};

const wireRequest = (http: HttpRequestFact, { path, contentType, body }: WireRequest): HttpRequestFact => ({
  ...http,
  method: 'POST',
  url: `${http.url}${path}`,
  headers: setHeader(http.headers, 'content-type', contentType),
  body,
});

const dispatchedAnswer = <Answer extends { 'response.http.error'?: HttpStreamError }>(received: Answer, { modelId }: WireRequest) => {
  const { 'response.http.error': failure, ...answer } = received;
  return { failure, answer: { ...answer, 'response.usageModelKey': modelId } };
};

export const dial = {
  anthropicMessages: (serialize: Serialize<'anthropicMessages'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.anthropicMessages.dial',
    through: {
      request: { needs: ['request.http', 'request.anthropicMessages'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.anthropicMessages?', 'response.usageModelKey'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const outbound = await serialize(facts['request.anthropicMessages']);
      const http = wireRequest(facts['request.http'], outbound);
      const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
      return failure === undefined ? answer : { ...answer, 'response.anthropicMessages': httpDialError(failure, format) };
    },
  }),
  anthropicMessagesCountTokens: (serialize: Serialize<'anthropicMessagesCountTokens'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.anthropicMessagesCountTokens.dial',
    through: {
      request: { needs: ['request.http', 'request.anthropicMessagesCountTokens'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.anthropicMessagesCountTokens?', 'response.usageModelKey'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const outbound = await serialize(facts['request.anthropicMessagesCountTokens']);
      const http = wireRequest(facts['request.http'], outbound);
      const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
      return failure === undefined ? answer : { ...answer, 'response.anthropicMessagesCountTokens': httpDialError(failure, format) };
    },
  }),
  decision: (serialize: SerializeDecision, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.decision.dial',
    through: {
      request: { needs: ['request.http', 'request.decision', 'provider.model'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.decision?', 'response.usageModelKey'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const outbound = serialize(facts['request.decision'], facts['provider.model']);
      const http = wireRequest(facts['request.http'], outbound);
      const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
      return failure === undefined ? answer : { ...answer, 'response.decision': httpDialError(failure, format) };
    },
  }),
  openaiChatCompletions: (serialize: Serialize<'openaiChatCompletions'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.openaiChatCompletions.dial',
    through: {
      request: { needs: ['request.http', 'request.openaiChatCompletions'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiChatCompletions?', 'response.usageModelKey'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const outbound = await serialize(facts['request.openaiChatCompletions']);
      const http = wireRequest(facts['request.http'], outbound);
      const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
      return failure === undefined ? answer : { ...answer, 'response.openaiChatCompletions': httpDialError(failure, format) };
    },
  }),
  openaiEmbeddings: (serialize: Serialize<'openaiEmbeddings'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.openaiEmbeddings.dial',
    through: {
      request: { needs: ['request.http', 'request.openaiEmbeddings'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiEmbeddings?', 'response.usageModelKey'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const outbound = await serialize(facts['request.openaiEmbeddings']);
      const http = wireRequest(facts['request.http'], outbound);
      const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
      return failure === undefined ? answer : { ...answer, 'response.openaiEmbeddings': httpDialError(failure, format) };
    },
  }),
  openaiImagesEdits: (serialize: Serialize<'openaiImagesEdits'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.openaiImagesEdits.dial',
    through: {
      request: { needs: ['request.http', 'request.openaiImagesEdits'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiImagesEdits?', 'response.usageModelKey'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const outbound = await serialize(facts['request.openaiImagesEdits']);
      const http = wireRequest(facts['request.http'], outbound);
      const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
      return failure === undefined ? answer : { ...answer, 'response.openaiImagesEdits': httpDialError(failure, format) };
    },
  }),
  openaiImagesGenerations: (serialize: Serialize<'openaiImagesGenerations'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.openaiImagesGenerations.dial',
    through: {
      request: { needs: ['request.http', 'request.openaiImagesGenerations'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiImagesGenerations?', 'response.usageModelKey'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const outbound = await serialize(facts['request.openaiImagesGenerations']);
      const http = wireRequest(facts['request.http'], outbound);
      const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
      return failure === undefined ? answer : { ...answer, 'response.openaiImagesGenerations': httpDialError(failure, format) };
    },
  }),
  openaiResponses: (serialize: Serialize<'openaiResponses'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.openaiResponses.dial',
    through: {
      request: { needs: ['request.http', 'request.openaiResponses'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiResponses?', 'response.usageModelKey'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const outbound = await serialize(facts['request.openaiResponses']);
      const http = wireRequest(facts['request.http'], outbound);
      const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
      return failure === undefined ? answer : { ...answer, 'response.openaiResponses': httpDialError(failure, format) };
    },
  }),
  openaiResponsesCompact: (serialize: Serialize<'openaiResponsesCompact'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.openaiResponsesCompact.dial',
    through: {
      request: { needs: ['request.http', 'request.openaiResponsesCompact'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiResponsesCompact?', 'response.usageModelKey'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const outbound = await serialize(facts['request.openaiResponsesCompact']);
      const http = wireRequest(facts['request.http'], outbound);
      const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
      return failure === undefined ? answer : { ...answer, 'response.openaiResponsesCompact': httpDialError(failure, format) };
    },
  }),
};
