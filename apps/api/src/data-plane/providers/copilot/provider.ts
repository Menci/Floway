import { fetchCopilotModels } from './fetch-models.ts';
import { chatCompletionsCopilotInterceptors } from './interceptors/chat-completions/index.ts';
import { messagesCopilotInterceptors, messagesCopilotSourceInterceptors, messagesCountTokensCopilotInterceptors } from './interceptors/messages/index.ts';
import { responsesCopilotInterceptors } from './interceptors/responses/index.ts';
import { emptyLedger, mergeLedger, projectLedger, type CopilotLedger } from './ledger.ts';
import { mergeClaudeVariants } from './merge-claude-variants.ts';
import { copilotPublicModelId, copilotRequestedModelAliasTarget } from './model-name.ts';
import { hasContext1mBeta, type ModelSelectionHints, resolveCopilotRawModel } from './model-selection.ts';
import { pricingForCopilotModelKey, pricingForCopilotPublicModelId } from './pricing.ts';
import type { CopilotRawModel } from './types.ts';
import type { UpstreamRecord } from '../../../repo/types.ts';
import { isCopilotAccountType, type CopilotAccountType } from '../../../shared/copilot.ts';
import { createCopilotUpstream } from '../../../shared/upstream/copilot.ts';
import type { EndpointKey } from '../../../shared/upstream/types.ts';
import { isStreamingEndpoint, kindForEndpoints, publicPathsToModelEndpoints } from '../endpoints.ts';
import { resolveEffectiveFlags } from '../flags-resolve.ts';
import { defaultsForProvider } from '../flags.ts';
import { inProcessMemo, readModelsStore, writeModelsStore } from '../models-store.ts';
import type { ModelProvider, ModelProviderInstance, ProviderCallResult, UpstreamModel } from '../types.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoint } from '@floway-dev/protocols/common';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

interface CopilotProviderData {
  rawModels: CopilotRawModel[];
}

interface CopilotUpstreamUser {
  login: string;
  avatar_url: string;
  name: string | null;
  id: number;
}

interface CopilotUpstreamConfig {
  githubToken: string;
  accountType: CopilotAccountType;
  user: CopilotUpstreamUser;
}

type CopilotUpstreamRecord = UpstreamRecord & {
  provider: 'copilot';
  config: CopilotUpstreamConfig;
};

const SOFT_MS = 10 * 60 * 1000;
const L1_TTL_MS = 120_000;

const providerData = (model: UpstreamModel): CopilotProviderData => model.providerData as CopilotProviderData;

// Project Copilot's raw `/models` shape into the slim provider-neutral fields
// shared by every provider. kind/upstreamEndpoints/providerData/
// enabledFlags are added by the caller because they depend on Copilot's
// endpoint knowledge and the upstream-level flag layer.
const copilotInternalModel = (model: CopilotRawModel): Omit<UpstreamModel, 'kind' | 'upstreamEndpoints' | 'providerData' | 'enabledFlags'> => {
  const limits: UpstreamModel['limits'] = {};
  if (model.capabilities?.limits?.max_output_tokens !== undefined) limits.max_output_tokens = model.capabilities.limits.max_output_tokens;
  if (model.capabilities?.limits?.max_context_window_tokens !== undefined) limits.max_context_window_tokens = model.capabilities.limits.max_context_window_tokens;
  if (model.capabilities?.limits?.max_prompt_tokens !== undefined) limits.max_prompt_tokens = model.capabilities.limits.max_prompt_tokens;

  const internal: Omit<UpstreamModel, 'kind' | 'upstreamEndpoints' | 'providerData' | 'enabledFlags'> = {
    id: model.id,
    limits,
  };
  if (model.owned_by !== undefined) internal.owned_by = model.owned_by;
  if (model.created !== undefined) internal.created = model.created;
  const displayName = model.display_name ?? model.name;
  if (displayName !== undefined) internal.display_name = displayName;
  return internal;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new Error(`Malformed copilot upstream config: ${field} must be a string`);
  return value;
};

const accountTypeField = (value: unknown): CopilotAccountType => {
  if (!isCopilotAccountType(value)) {
    throw new Error('Malformed copilot upstream config: accountType must be one of individual, business, enterprise');
  }
  return value;
};

const nullableStringField = (value: unknown, field: string): string | null => {
  if (value !== null && typeof value !== 'string') throw new Error(`Malformed copilot upstream config: ${field} must be a string or null`);
  return value;
};

const numberField = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Malformed copilot upstream config: ${field} must be an integer`);
  return value;
};

const copilotUserField = (value: unknown): CopilotUpstreamUser => {
  if (!isRecord(value)) throw new Error('Malformed copilot upstream config: user must be an object');
  return {
    login: stringField(value.login, 'user.login'),
    avatar_url: stringField(value.avatar_url, 'user.avatar_url'),
    name: nullableStringField(value.name, 'user.name'),
    id: numberField(value.id, 'user.id'),
  };
};

const assertCopilotUpstreamRecord = (record: UpstreamRecord): CopilotUpstreamRecord => {
  if (record.provider !== 'copilot') throw new Error(`Expected copilot upstream record, got ${record.provider}`);
  if (!isRecord(record.config)) throw new Error('Malformed copilot upstream config: config must be an object');
  return {
    ...record,
    provider: 'copilot',
    config: {
      githubToken: stringField(record.config.githubToken, 'githubToken'),
      accountType: accountTypeField(record.config.accountType),
      user: copilotUserField(record.config.user),
    },
  };
};

const withMessagesCountTokens = (endpoints: readonly ModelEndpoint[]): ModelEndpoint[] =>
  endpoints.includes('messages') && !endpoints.includes('messages_count_tokens') ? [...endpoints, 'messages_count_tokens'] : [...endpoints];

const inferredChatCompletionsSupport = (model: CopilotRawModel): boolean => model.supported_endpoints === undefined && model.capabilities?.type === 'chat';

const inferredEmbeddingSupport = (model: CopilotRawModel): boolean => model.supported_endpoints === undefined && model.capabilities?.type === 'embeddings';

const rawModelSupportsEndpoint = (model: CopilotRawModel, endpoint: ModelEndpoint): boolean => {
  const normalized = endpoint === 'messages_count_tokens' ? 'messages' : endpoint;
  const declared = publicPathsToModelEndpoints(model.supported_endpoints ?? []);
  if (declared.includes(normalized)) return true;
  // Copilot's Anthropic-family entries have historically under-reported their
  // native Messages path. Treating claude-* as Messages-capable is a
  // Copilot-provider workaround only; custom providers must declare their own
  // supported endpoints.
  if (normalized === 'messages' && model.id.startsWith('claude-')) return true;
  if (normalized === 'chat_completions') {
    return inferredChatCompletionsSupport(model);
  }
  if (normalized === 'embeddings') return inferredEmbeddingSupport(model);
  return false;
};

const copilotModelEndpoints = (publicModel: CopilotRawModel, rawModels: readonly CopilotRawModel[]): ModelEndpoint[] => {
  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'responses'))) {
    return ['responses'];
  }

  if (publicModel.id.startsWith('claude-') || rawModels.some(model => rawModelSupportsEndpoint(model, 'messages'))) {
    return withMessagesCountTokens(['messages']);
  }

  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'chat_completions'))) {
    return ['chat_completions'];
  }

  return rawModels.some(model => rawModelSupportsEndpoint(model, 'embeddings')) ? ['embeddings'] : [];
};

const chatReasoningEffort = (body: Omit<ChatCompletionsPayload, 'model'>): string | undefined => (body.reasoning_effort && body.reasoning_effort !== 'none' ? body.reasoning_effort : undefined);

const messagesReasoningEffort = (body: Omit<MessagesPayload, 'model'>): string | undefined => body.output_config?.effort;

const responsesReasoningEffort = (body: Omit<ResponsesPayload, 'model'>): string | undefined => (body.reasoning?.effort && body.reasoning.effort !== 'none' ? body.reasoning.effort : undefined);

const rawModelFor = (model: UpstreamModel, endpoint: ModelEndpoint, hints: ModelSelectionHints = {}): CopilotRawModel => {
  // Copilot exposes one canonical public Claude model id per family. Raw
  // variant selection is derived from request fields such as reasoning effort
  // and anthropic-beta, not from the client's original model alias string.
  const rawModels = providerData(model).rawModels.filter(rawModel => rawModelSupportsEndpoint(rawModel, endpoint));
  if (rawModels.length === 0) {
    throw new Error(`Copilot provider exposed ${endpoint} for ${model.id}, but no raw variant supports that endpoint`);
  }
  return resolveCopilotRawModel({ object: 'list', data: rawModels }, model.id, hints) ?? rawModels[0];
};

// The Messages and count_tokens call paths receive the UNFILTERED
// anthropic-beta as a typed parameter so variant selection (e.g.
// context-1m-2025-08-07 -> the claude-*-1m-internal variant) sees the
// caller's full intent. The wire `anthropic-beta` header that ultimately
// reaches the upstream is the filtered subset written by
// withAnthropicBetaHeaderFiltered into `invocation.headers`; that header is
// passed through unchanged by the `call` helper below.
const copilotEmbeddingsBody = (body: Record<string, unknown>): Record<string, unknown> => {
  if (typeof body.input !== 'string') return body;

  // OpenAI-compatible clients may send scalar string input, but Copilot's
  // upstream /embeddings endpoint currently returns 400 unless text input is
  // wrapped as an array. Keep this workaround at the Copilot provider boundary
  // so custom OpenAI-compatible upstreams receive the caller's body unchanged.
  // References:
  // https://platform.openai.com/docs/api-reference/embeddings/create
  // https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-embeddings.ts#L19-L21
  // https://github.com/BerriAI/litellm/blob/c8fb77f119ad69a80f5fde088efd3a1aa77f458b/litellm/proxy/proxy_server.py#L7826-L7839
  return { ...body, input: [body.input] };
};

const finalizeCopilotModels = (rawModels: CopilotRawModel[], enabledFlags: ReadonlySet<string>): UpstreamModel[] => {
  const merged = mergeClaudeVariants({ object: 'list', data: rawModels });
  const groups = new Map<string, CopilotRawModel[]>();
  for (const rawModel of rawModels) {
    const id = copilotPublicModelId(rawModel.id);
    groups.set(id, [...(groups.get(id) ?? []), rawModel]);
  }

  const models: UpstreamModel[] = [];
  for (const mergedModel of merged.data) {
    const variants = groups.get(mergedModel.id) ?? [mergedModel];
    const upstreamEndpoints = copilotModelEndpoints(mergedModel, variants);
    const cost = pricingForCopilotPublicModelId(mergedModel.id);
    models.push({
      ...copilotInternalModel(mergedModel),
      kind: kindForEndpoints(upstreamEndpoints),
      upstreamEndpoints,
      providerData: { rawModels: variants } satisfies CopilotProviderData,
      ...(cost ? { cost } : {}),
      enabledFlags,
    });
  }
  return models;
};

export const createCopilotProvider = async (record: UpstreamRecord): Promise<ModelProviderInstance> => {
  const copilot = assertCopilotUpstreamRecord(record);
  const upstream = createCopilotUpstream(copilot.id, copilot.name, copilot.config.githubToken, copilot.config.accountType);
  // Computed once: only the upstream layer applies for this provider kind
  // (no per-model override layer). Azure recomputes per deployment.
  const upstreamFlags = resolveEffectiveFlags(defaultsForProvider('copilot'), [copilot.flagOverrides]);

  const call = async (
    endpoint: EndpointKey,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    rawModel: CopilotRawModel,
    headers: Record<string, string> | undefined,
  ): Promise<ProviderCallResult> => {
    const requestBody = isStreamingEndpoint(endpoint) ? { ...body, stream: true, model: rawModel.id } : { ...body, model: rawModel.id };
    const response = await upstream.fetch(
      endpoint,
      {
        method: 'POST',
        body: JSON.stringify(requestBody),
        signal,
      },
      headers && Object.keys(headers).length > 0 ? { extraHeaders: headers } : undefined,
    );
    return { response, modelKey: rawModel.id };
  };

  const callMessagesEndpoint =
    (endpoint: 'messages' | 'messages_count_tokens') => (model: UpstreamModel, body: Omit<MessagesPayload, 'model'>, signal?: AbortSignal, headers?: Record<string, string>, anthropicBeta?: readonly string[]) => {
      const rawModel = rawModelFor(model, endpoint, {
        context1m: hasContext1mBeta(anthropicBeta),
        reasoningEffort: messagesReasoningEffort(body),
      });
      return call(endpoint, body, signal, rawModel, headers);
    };

  const provider: ModelProvider = {
    getProvidedModels: () =>
      inProcessMemo(copilot.id, L1_TTL_MS, async () => {
        const ledger = (await readModelsStore<CopilotLedger>(copilot.id)) ?? emptyLedger();
        const now = Date.now();
        const initial = projectLedger(ledger, now);
        if (now - ledger.fetchedAt < SOFT_MS && initial.length > 0) {
          return finalizeCopilotModels(initial, upstreamFlags);
        }
        try {
          const response = await fetchCopilotModels(upstream);
          const merged = mergeLedger(ledger, response, now);
          await writeModelsStore<CopilotLedger>(copilot.id, merged);
          return finalizeCopilotModels(projectLedger(merged, now), upstreamFlags);
        } catch (err) {
          if (initial.length > 0) return finalizeCopilotModels(initial, upstreamFlags);
          throw err;
        }
      }),
    getPricingForModelKey: pricingForCopilotModelKey,
    callChatCompletions: (model, body, signal, headers) => {
      const rawModel = rawModelFor(model, 'chat_completions', {
        reasoningEffort: chatReasoningEffort(body),
      });
      return call('chat_completions', body, signal, rawModel, headers);
    },
    callResponses: (model, body, signal, headers) => {
      const rawModel = rawModelFor(model, 'responses', {
        reasoningEffort: responsesReasoningEffort(body),
      });
      return call('responses', body, signal, rawModel, headers);
    },
    callMessages: callMessagesEndpoint('messages'),
    callMessagesCountTokens: callMessagesEndpoint('messages_count_tokens'),
    callEmbeddings: (model, body, signal, headers) => call('embeddings', copilotEmbeddingsBody(body), signal, rawModelFor(model, 'embeddings'), headers),
    // Copilot has no /images/... upstream. getProvidedModels never emits a
    // kind='image' model for Copilot bindings, so the source-side dispatcher
    // in apps/api/src/data-plane/images/serve.ts never selects this provider
    // for image requests. These stubs satisfy the ModelProvider interface
    // only; they are unreachable in normal operation. The `headers` parameter
    // is present for signature parity with the other call methods even
    // though it is never consumed.
    callImagesGenerations: () => {
      throw new Error('Copilot provider does not implement images_generations');
    },
    callImagesEdits: () => {
      throw new Error('Copilot provider does not implement images_edits');
    },
  };

  return {
    upstream: copilot.id,
    providerKind: 'copilot',
    name: copilot.name,
    provider,
    sourceInterceptors: {
      messages: messagesCopilotSourceInterceptors,
    },
    targetInterceptors: {
      messages: messagesCopilotInterceptors,
      messagesCountTokens: messagesCountTokensCopilotInterceptors,
      responses: responsesCopilotInterceptors,
      chatCompletions: chatCompletionsCopilotInterceptors,
    },
    resolveRequestedModelId: copilotRequestedModelAliasTarget,
  };
};
