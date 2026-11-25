import { defineCopilotStage } from '../facts.ts';
import { setHeader, type HttpRequestFact } from '@floway-dev/http';
import { httpDialError, type FormatProtocolError, type GatewayFacts, type ProviderOperation } from '@floway-dev/provider';

interface WireRequest {
  path: string;
  body: Uint8Array;
  contentType: string;
}

type Serialize<Op extends ProviderOperation> = (payload: GatewayFacts[`request.${Op}`]) => WireRequest | Promise<WireRequest>;
type SerializeDecision = (payload: GatewayFacts['request.decision'], model: GatewayFacts['provider.model']) => WireRequest;

export const jsonRequest = (path: string, value: object): WireRequest => ({
  path,
  body: new TextEncoder().encode(JSON.stringify(value)),
  contentType: 'application/json',
});

const wireRequest = (http: HttpRequestFact, { path, contentType, body }: WireRequest): HttpRequestFact => ({
  ...http,
  method: 'POST',
  url: `${http.url}${path}`,
  headers: setHeader(http.headers, 'content-type', contentType),
  body,
});

export const dial = {
  anthropicMessages: (serialize: Serialize<'anthropicMessages'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.anthropicMessages.dial',
    through: {
      request: { needs: ['request.http', 'request.anthropicMessages'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.anthropicMessages?'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const http = wireRequest(facts['request.http'], await serialize(facts['request.anthropicMessages']));
      const { 'response.http.error': failure, ...answer } = await scope.next({ ...facts, 'request.http': http });
      return failure === undefined ? answer : { ...answer, 'response.anthropicMessages': httpDialError(failure, format) };
    },
  }),
  anthropicMessagesCountTokens: (serialize: Serialize<'anthropicMessagesCountTokens'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.anthropicMessagesCountTokens.dial',
    through: {
      request: { needs: ['request.http', 'request.anthropicMessagesCountTokens'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.anthropicMessagesCountTokens?'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const http = wireRequest(facts['request.http'], await serialize(facts['request.anthropicMessagesCountTokens']));
      const { 'response.http.error': failure, ...answer } = await scope.next({ ...facts, 'request.http': http });
      return failure === undefined ? answer : { ...answer, 'response.anthropicMessagesCountTokens': httpDialError(failure, format) };
    },
  }),
  decision: (serialize: SerializeDecision, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.decision.dial',
    through: {
      request: { needs: ['request.http', 'request.decision', 'provider.model'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.decision?'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const http = wireRequest(facts['request.http'], serialize(facts['request.decision'], facts['provider.model']));
      const { 'response.http.error': failure, ...answer } = await scope.next({ ...facts, 'request.http': http });
      return failure === undefined ? answer : { ...answer, 'response.decision': httpDialError(failure, format) };
    },
  }),
  openaiChatCompletions: (serialize: Serialize<'openaiChatCompletions'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.openaiChatCompletions.dial',
    through: {
      request: { needs: ['request.http', 'request.openaiChatCompletions'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiChatCompletions?'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const http = wireRequest(facts['request.http'], await serialize(facts['request.openaiChatCompletions']));
      const { 'response.http.error': failure, ...answer } = await scope.next({ ...facts, 'request.http': http });
      return failure === undefined ? answer : { ...answer, 'response.openaiChatCompletions': httpDialError(failure, format) };
    },
  }),
  openaiEmbeddings: (serialize: Serialize<'openaiEmbeddings'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.openaiEmbeddings.dial',
    through: {
      request: { needs: ['request.http', 'request.openaiEmbeddings'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiEmbeddings?'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const http = wireRequest(facts['request.http'], await serialize(facts['request.openaiEmbeddings']));
      const { 'response.http.error': failure, ...answer } = await scope.next({ ...facts, 'request.http': http });
      return failure === undefined ? answer : { ...answer, 'response.openaiEmbeddings': httpDialError(failure, format) };
    },
  }),
  openaiImagesEdits: (serialize: Serialize<'openaiImagesEdits'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.openaiImagesEdits.dial',
    through: {
      request: { needs: ['request.http', 'request.openaiImagesEdits'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiImagesEdits?'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const http = wireRequest(facts['request.http'], await serialize(facts['request.openaiImagesEdits']));
      const { 'response.http.error': failure, ...answer } = await scope.next({ ...facts, 'request.http': http });
      return failure === undefined ? answer : { ...answer, 'response.openaiImagesEdits': httpDialError(failure, format) };
    },
  }),
  openaiImagesGenerations: (serialize: Serialize<'openaiImagesGenerations'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.openaiImagesGenerations.dial',
    through: {
      request: { needs: ['request.http', 'request.openaiImagesGenerations'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiImagesGenerations?'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const http = wireRequest(facts['request.http'], await serialize(facts['request.openaiImagesGenerations']));
      const { 'response.http.error': failure, ...answer } = await scope.next({ ...facts, 'request.http': http });
      return failure === undefined ? answer : { ...answer, 'response.openaiImagesGenerations': httpDialError(failure, format) };
    },
  }),
  openaiResponses: (serialize: Serialize<'openaiResponses'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.openaiResponses.dial',
    through: {
      request: { needs: ['request.http', 'request.openaiResponses'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiResponses?'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const http = wireRequest(facts['request.http'], await serialize(facts['request.openaiResponses']));
      const { 'response.http.error': failure, ...answer } = await scope.next({ ...facts, 'request.http': http });
      return failure === undefined ? answer : { ...answer, 'response.openaiResponses': httpDialError(failure, format) };
    },
  }),
  openaiResponsesCompact: (serialize: Serialize<'openaiResponsesCompact'>, format: FormatProtocolError) => defineCopilotStage({
    name: 'copilot.openaiResponsesCompact.dial',
    through: {
      request: { needs: ['request.http', 'request.openaiResponsesCompact'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiResponsesCompact?'], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const http = wireRequest(facts['request.http'], await serialize(facts['request.openaiResponsesCompact']));
      const { 'response.http.error': failure, ...answer } = await scope.next({ ...facts, 'request.http': http });
      return failure === undefined ? answer : { ...answer, 'response.openaiResponsesCompact': httpDialError(failure, format) };
    },
  }),
};
