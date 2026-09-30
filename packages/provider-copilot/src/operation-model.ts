import { resolveCopilotRawModel, type ModelSelectionHints } from './model-selection.ts';
import type { CopilotRawModel } from './types.ts';
import type { ModelEndpointKey } from '@floway-dev/protocols/common';
import type { ProviderModel } from '@floway-dev/provider';

interface CopilotProviderData { readonly rawModels: readonly CopilotRawModel[] }

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
  return false;
};

export const rawModelFor = (model: Pick<ProviderModel, 'id' | 'providerData'>, endpoint: ModelEndpointKey, hints: ModelSelectionHints = {}): CopilotRawModel => {
  // Copilot exposes one canonical public Claude model id per family. Raw
  // variant selection is derived from request body fields and parsed Anthropic Messages
  // beta intent, not from the client's original model alias string.
  const rawModels = (model.providerData as CopilotProviderData).rawModels.filter(rawModel => rawModelSupportsEndpoint(rawModel, endpoint));
  if (rawModels.length === 0) {
    throw new Error(`Copilot provider exposed ${endpoint} for ${model.id}, but no raw variant supports that endpoint`);
  }
  return resolveCopilotRawModel({ object: 'list', data: rawModels }, model.id, hints) ?? rawModels[0];
};

export const copilotOpenAIEmbeddingsBody = (body: Record<string, unknown>): Record<string, unknown> => {
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
