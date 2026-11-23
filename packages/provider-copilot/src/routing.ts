import { type ModelSelectionHints, resolveCopilotRawModel } from './model-selection.ts';
import type { CopilotRawModel } from './types.ts';
import type { ModelEndpointKey } from '@floway-dev/protocols/common';
import type { ProviderModelFacts } from '@floway-dev/provider';

export interface CopilotProviderData {
  rawModels: CopilotRawModel[];
}

// Copilot's `/models` reports each model's served endpoints as public paths; map
// one onto our structured endpoint key. Both `/x` and `/v1/x` spellings appear.
// Copilot is the only upstream whose catalog speaks paths — operator config and
// our own constants are structured — so this lives here, not in a shared helper.
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

export const rawModelSupportsEndpoint = (model: CopilotRawModel, endpoint: ModelEndpointKey): boolean => {
  if ((model.supported_endpoints ?? []).some(path => copilotPathToModelEndpoint(path) === endpoint)) return true;
  // Copilot's Anthropic-family entries have historically under-reported their
  // native Anthropic Messages path, so treat claude-* as Anthropic-Messages-capable.
  if (endpoint === 'anthropicMessages' && model.id.startsWith('claude-')) return true;
  if (endpoint === 'openaiChatCompletions') {
    return model.supported_endpoints === undefined && model.capabilities?.type === 'chat';
  }
  if (endpoint === 'openaiEmbeddings') return model.supported_endpoints === undefined && model.capabilities?.type === 'embeddings';
  // A decision model declares `capabilities.type: "decisions"`. The advertised
  // path alone cannot decide this: the same family is reached over
  // `/v1/systemone` and `/v1/decisions`, and a catalog that omits
  // `supported_endpoints` (or lists a path this map does not know yet) would
  // otherwise fall through to the chat fallback and be routed to
  // /v1/chat/completions. The declared type is the authority.
  if (endpoint === 'decision') return model.capabilities?.type === 'decisions';
  return false;
};

export const rawModelFor = (model: ProviderModelFacts, endpoint: ModelEndpointKey, hints: ModelSelectionHints = {}): CopilotRawModel => {
  // Copilot exposes one canonical public Claude model id per family. Raw
  // variant selection is derived from request body fields and parsed Anthropic Messages
  // beta intent, not from the client's original model alias string.
  const rawModels = copilotProviderData(model).rawModels.filter(rawModel => rawModelSupportsEndpoint(rawModel, endpoint));
  if (rawModels.length === 0) {
    throw new Error(`Copilot provider exposed ${endpoint} for ${model.id}, but no raw variant supports that endpoint`);
  }
  return resolveCopilotRawModel({ object: 'list', data: rawModels }, model.id, hints) ?? rawModels[0];
};

export const copilotProviderData = (model: ProviderModelFacts): CopilotProviderData => model.providerData as CopilotProviderData;
