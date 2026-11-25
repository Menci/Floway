import type { CopilotServices } from '../../service.ts';
import { defineCopilotStage } from '../facts.ts';
import type { HttpHeaders } from '@floway-dev/http';
import type { GatewayFacts, ProviderOperation } from '@floway-dev/provider';

type Payload<Op extends ProviderOperation> = GatewayFacts[`request.${Op}`];
type PayloadRewrite<Op extends ProviderOperation> = (
  payload: Payload<Op>,
  model: GatewayFacts['provider.model'],
  services: Readonly<CopilotServices>,
) => Payload<Op> | Promise<Payload<Op>>;
type HeaderRewrite<Op extends ProviderOperation> = (
  payload: Payload<Op>,
  headers: HttpHeaders,
  model: GatewayFacts['provider.model'],
) => HttpHeaders | Promise<HttpHeaders>;

export const rewritePayload = {
  anthropicMessages: (name: string, rewrite: PayloadRewrite<'anthropicMessages'>) => defineCopilotStage({
    name: `copilot.anthropicMessages.${name}`,
    through: {
      request: { needs: ['request.anthropicMessages', 'provider.model'], provides: ['request.anthropicMessages'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const current = facts['request.anthropicMessages'];
      const payload = await rewrite(current, facts['provider.model'], scope.services);
      return await scope.next(payload === current ? facts : { ...facts, 'request.anthropicMessages': payload });
    },
  }),
  anthropicMessagesCountTokens: (name: string, rewrite: PayloadRewrite<'anthropicMessagesCountTokens'>) => defineCopilotStage({
    name: `copilot.anthropicMessagesCountTokens.${name}`,
    through: {
      request: { needs: ['request.anthropicMessagesCountTokens', 'provider.model'], provides: ['request.anthropicMessagesCountTokens'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const current = facts['request.anthropicMessagesCountTokens'];
      const payload = await rewrite(current, facts['provider.model'], scope.services);
      return await scope.next(payload === current ? facts : { ...facts, 'request.anthropicMessagesCountTokens': payload });
    },
  }),
  openaiChatCompletions: (name: string, rewrite: PayloadRewrite<'openaiChatCompletions'>) => defineCopilotStage({
    name: `copilot.openaiChatCompletions.${name}`,
    through: {
      request: { needs: ['request.openaiChatCompletions', 'provider.model'], provides: ['request.openaiChatCompletions'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const current = facts['request.openaiChatCompletions'];
      const payload = await rewrite(current, facts['provider.model'], scope.services);
      return await scope.next(payload === current ? facts : { ...facts, 'request.openaiChatCompletions': payload });
    },
  }),
  openaiResponses: (name: string, rewrite: PayloadRewrite<'openaiResponses'>) => defineCopilotStage({
    name: `copilot.openaiResponses.${name}`,
    through: {
      request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const current = facts['request.openaiResponses'];
      const payload = await rewrite(current, facts['provider.model'], scope.services);
      return await scope.next(payload === current ? facts : { ...facts, 'request.openaiResponses': payload });
    },
  }),
  openaiResponsesCompact: (name: string, rewrite: PayloadRewrite<'openaiResponsesCompact'>) => defineCopilotStage({
    name: `copilot.openaiResponsesCompact.${name}`,
    through: {
      request: { needs: ['request.openaiResponsesCompact', 'provider.model'], provides: ['request.openaiResponsesCompact'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const current = facts['request.openaiResponsesCompact'];
      const payload = await rewrite(current, facts['provider.model'], scope.services);
      return await scope.next(payload === current ? facts : { ...facts, 'request.openaiResponsesCompact': payload });
    },
  }),
  openaiEmbeddings: (name: string, rewrite: PayloadRewrite<'openaiEmbeddings'>) => defineCopilotStage({
    name: `copilot.openaiEmbeddings.${name}`,
    through: {
      request: { needs: ['request.openaiEmbeddings', 'provider.model'], provides: ['request.openaiEmbeddings'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const current = facts['request.openaiEmbeddings'];
      const payload = await rewrite(current, facts['provider.model'], scope.services);
      return await scope.next(payload === current ? facts : { ...facts, 'request.openaiEmbeddings': payload });
    },
  }),
  openaiImagesGenerations: (name: string, rewrite: PayloadRewrite<'openaiImagesGenerations'>) => defineCopilotStage({
    name: `copilot.openaiImagesGenerations.${name}`,
    through: {
      request: { needs: ['request.openaiImagesGenerations', 'provider.model'], provides: ['request.openaiImagesGenerations'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const current = facts['request.openaiImagesGenerations'];
      const payload = await rewrite(current, facts['provider.model'], scope.services);
      return await scope.next(payload === current ? facts : { ...facts, 'request.openaiImagesGenerations': payload });
    },
  }),
};

export const rewriteHeaders = {
  anthropicMessages: (name: string, rewrite: HeaderRewrite<'anthropicMessages'>) => defineCopilotStage({
    name: `copilot.anthropicMessages.${name}`,
    through: {
      request: { needs: ['request.anthropicMessages', 'request.http', 'provider.model'], provides: ['request.http'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const http = facts['request.http'];
      const headers = await rewrite(facts['request.anthropicMessages'], http.headers, facts['provider.model']);
      return await scope.next(headers === http.headers ? facts : { ...facts, 'request.http': { ...http, headers } });
    },
  }),
  anthropicMessagesCountTokens: (name: string, rewrite: HeaderRewrite<'anthropicMessagesCountTokens'>) => defineCopilotStage({
    name: `copilot.anthropicMessagesCountTokens.${name}`,
    through: {
      request: { needs: ['request.anthropicMessagesCountTokens', 'request.http', 'provider.model'], provides: ['request.http'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const http = facts['request.http'];
      const headers = await rewrite(facts['request.anthropicMessagesCountTokens'], http.headers, facts['provider.model']);
      return await scope.next(headers === http.headers ? facts : { ...facts, 'request.http': { ...http, headers } });
    },
  }),
  openaiChatCompletions: (name: string, rewrite: HeaderRewrite<'openaiChatCompletions'>) => defineCopilotStage({
    name: `copilot.openaiChatCompletions.${name}`,
    through: {
      request: { needs: ['request.openaiChatCompletions', 'request.http', 'provider.model'], provides: ['request.http'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const http = facts['request.http'];
      const headers = await rewrite(facts['request.openaiChatCompletions'], http.headers, facts['provider.model']);
      return await scope.next(headers === http.headers ? facts : { ...facts, 'request.http': { ...http, headers } });
    },
  }),
  openaiResponses: (name: string, rewrite: HeaderRewrite<'openaiResponses'>) => defineCopilotStage({
    name: `copilot.openaiResponses.${name}`,
    through: {
      request: { needs: ['request.openaiResponses', 'request.http', 'provider.model'], provides: ['request.http'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const http = facts['request.http'];
      const headers = await rewrite(facts['request.openaiResponses'], http.headers, facts['provider.model']);
      return await scope.next(headers === http.headers ? facts : { ...facts, 'request.http': { ...http, headers } });
    },
  }),
  openaiResponsesCompact: (name: string, rewrite: HeaderRewrite<'openaiResponsesCompact'>) => defineCopilotStage({
    name: `copilot.openaiResponsesCompact.${name}`,
    through: {
      request: { needs: ['request.openaiResponsesCompact', 'request.http', 'provider.model'], provides: ['request.http'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const http = facts['request.http'];
      const headers = await rewrite(facts['request.openaiResponsesCompact'], http.headers, facts['provider.model']);
      return await scope.next(headers === http.headers ? facts : { ...facts, 'request.http': { ...http, headers } });
    },
  }),
};
