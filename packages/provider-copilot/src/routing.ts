import { copilotModelSupportsFastVariant, resolveCopilotRawModel, type ModelSelectionHints } from './model-selection.ts';
import type { CopilotRawModel } from './types.ts';
import type { DecisionProtocol, DecisionTarget, ModelEndpointKey, ModelEndpoints } from '@floway-dev/protocols/common';
import type { ProviderModel } from '@floway-dev/provider';

export interface CopilotProviderData {
  rawModels: CopilotRawModel[];
}

export type CopilotRoutableModel = Pick<ProviderModel, 'id' | 'providerData'>;

const COPILOT_DECISION_PATH_PROTOCOL: Readonly<Record<string, DecisionProtocol>> = {
  '/systemone': 'typesafe-systemone',
  '/v1/systemone': 'typesafe-systemone',
  '/decisions': 'openai-decisions',
  '/v1/decisions': 'openai-decisions',
};

const copilotPathToModelEndpoint = (path: string): ModelEndpointKey | undefined => {
  switch (path) {
  case '/chat/completions':
  case '/v1/chat/completions':
    return 'openaiChatCompletions';
  case '/responses':
  case '/v1/responses':
    return 'openaiResponses';
  case '/v1/messages':
  case '/messages':
    return 'anthropicMessages';
  case '/embeddings':
  case '/v1/embeddings':
    return 'openaiEmbeddings';
  case '/images/generations':
  case '/v1/images/generations':
    return 'openaiImagesGenerations';
  case '/images/edits':
  case '/v1/images/edits':
    return 'openaiImagesEdits';
  case '/systemone':
  case '/v1/systemone':
  case '/decisions':
  case '/v1/decisions':
    return 'decision';
  default:
    return undefined;
  }
};

const rawModelSupportsEndpoint = (model: CopilotRawModel, endpoint: ModelEndpointKey): boolean => {
  if ((model.supported_endpoints ?? []).some(path => copilotPathToModelEndpoint(path) === endpoint)) return true;
  // Copilot's Anthropic-family entries have historically under-reported their
  // native Anthropic Messages path, so treat claude-* as Anthropic-Messages-capable.
  if (endpoint === 'anthropicMessages' && model.id.startsWith('claude-')) return true;
  if (endpoint === 'openaiChatCompletions') {
    return model.supported_endpoints === undefined && model.capabilities?.type === 'chat';
  }
  if (endpoint === 'openaiEmbeddings') return model.supported_endpoints === undefined && model.capabilities?.type === 'embeddings';
  if (endpoint === 'decision') return model.capabilities?.type === 'decisions';
  return false;
};

export const copilotModelEndpoints = (rawModels: readonly CopilotRawModel[]): ModelEndpoints => {
  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'openaiResponses'))) {
    return { openaiResponses: {} };
  }

  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'anthropicMessages'))) {
    return { anthropicMessages: {} };
  }

  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'openaiChatCompletions'))) {
    return { openaiChatCompletions: {} };
  }

  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'openaiEmbeddings'))) return { openaiEmbeddings: {} };
  const imageEndpoints: ModelEndpoints = {
    ...(rawModels.some(model => rawModelSupportsEndpoint(model, 'openaiImagesGenerations')) ? { openaiImagesGenerations: {} } : {}),
    ...(rawModels.some(model => rawModelSupportsEndpoint(model, 'openaiImagesEdits')) ? { openaiImagesEdits: {} } : {}),
  };
  if (Object.keys(imageEndpoints).length > 0) return imageEndpoints;
  return rawModels.some(model => rawModelSupportsEndpoint(model, 'decision')) ? { decision: {} } : {};
};

export const copilotDecisionTarget = (variants: readonly CopilotRawModel[]): DecisionTarget => {
  const advertised = variants.flatMap(variant => variant.supported_endpoints ?? []);
  const protocols = [...new Set(advertised.flatMap(path => COPILOT_DECISION_PATH_PROTOCOL[path] ?? []))];
  if (protocols.length !== 1) {
    throw new Error(
      `Copilot decision model advertises ${protocols.length === 0 ? 'no decision path' : `multiple decision dialects (${protocols.join(', ')})`} in supported_endpoints ${JSON.stringify(advertised)}`,
    );
  }
  return { protocol: protocols[0] };
};

export const rawModelFor = (
  model: CopilotRoutableModel,
  endpoint: ModelEndpointKey,
  hints: ModelSelectionHints = {},
): CopilotRawModel => {
  const providerData = model.providerData as CopilotProviderData | undefined;
  if (providerData === undefined) throw new Error(`Copilot model ${model.id} has no raw model data`);
  const rawModels = providerData.rawModels.filter(rawModel => rawModelSupportsEndpoint(rawModel, endpoint));
  if (rawModels.length === 0) {
    throw new Error(`Copilot provider exposed ${endpoint} for ${model.id}, but no raw variant supports that endpoint`);
  }
  return resolveCopilotRawModel({ object: 'list', data: rawModels }, model.id, hints) ?? rawModels[0];
};

export const copilotModelHasFastVariant = (model: CopilotRoutableModel): boolean => {
  const providerData = model.providerData as CopilotProviderData | undefined;
  if (providerData === undefined) throw new Error(`Copilot model ${model.id} has no raw model data`);
  return copilotModelSupportsFastVariant(providerData.rawModels);
};

export const chatReasoningEffort = (body: { readonly reasoning_effort?: string | null }): string | undefined =>
  body.reasoning_effort && body.reasoning_effort !== 'none' ? body.reasoning_effort : undefined;

export const anthropicMessagesReasoningEffort = (body: { readonly output_config?: { readonly effort?: string | null } | null }): string | undefined =>
  body.output_config?.effort ?? undefined;

export const openaiResponsesReasoningEffort = (body: { readonly reasoning?: { readonly effort?: string | null } | null }): string | undefined =>
  body.reasoning?.effort && body.reasoning.effort !== 'none' ? body.reasoning.effort : undefined;

export const copilotOpenAIEmbeddingsBody = <Body extends Record<string, unknown>>(body: Body): Body | (Omit<Body, 'input'> & { input: [unknown] }) => {
  if (typeof body.input !== 'string') return body;

  // OpenAI-compatible clients may send scalar string input, but Copilot's
  // upstream /embeddings endpoint currently returns 400 unless text input is
  // wrapped as an array.
  // References:
  // https://platform.openai.com/docs/api-reference/embeddings/create
  // https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-embeddings.ts#L19-L21
  // https://github.com/BerriAI/litellm/blob/c8fb77f119ad69a80f5fde088efd3a1aa77f458b/litellm/proxy/proxy_server.py#L7826-L7839
  return { ...body, input: [body.input] };
};
