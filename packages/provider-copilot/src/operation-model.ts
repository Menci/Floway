import { resolveCopilotRawModel, type ModelSelectionHints } from './model-selection.ts';
import type { CopilotRawModel } from './types.ts';
import type { DecisionProtocol, DecisionTarget, ModelEndpointKey } from '@floway-dev/protocols/common';
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
  case '/systemone':
  case '/v1/systemone':
  case '/decisions':
  case '/v1/decisions':
    return 'decision';
  default:
    return undefined;
  }
};

// Copilot names the dialect each decision model serves through the path it
// advertises: `/v1/systemone` speaks System One and `/v1/decisions` speaks
// OpenAI Decisions. The two are exclusive per model — calling the other one
// answers 400 `no_available_model_endpoints` — so the advertised path is the
// only authority for the target dialect.
const COPILOT_DECISION_PATH_PROTOCOL: Readonly<Record<string, DecisionProtocol>> = {
  '/systemone': 'typesafe-systemone',
  '/v1/systemone': 'typesafe-systemone',
  '/decisions': 'openai-decisions',
  '/v1/decisions': 'openai-decisions',
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
