import {
  CHATGPT_BACKEND_BASE,
  CHATGPT_CLI_VERSION,
  CHATGPT_IMAGE_MODEL_ID,
  CHATGPT_MODELS_PATH,
  CHATGPT_ORIGINATOR,
  CHATGPT_USER_AGENT,
} from './constants.ts';
import { GPT_IMAGE_2_PRICING, pricingForChatGPTModelKey } from './pricing.ts';
import { ProviderModelsUnavailableError, type Fetcher, type FlagId, type ProviderModel, type UpstreamChatModelConfig } from '@floway-dev/provider';

interface ChatGPTProviderData {
  contextWindow: number;
  useResponsesLite: boolean;
  codex?: CodexModelSettings;
}

// https://github.com/openai/codex/blob/6c0cee502d215e5df2dd9a303cf2e252229c9e12/codex-rs/models-manager/models.json
const CODEX_STRING_SETTINGS = ['tool_mode', 'apply_patch_tool_type', 'multi_agent_version', 'multi_agent_reasoning_effort', 'default_verbosity'] as const;
const CODEX_BOOLEAN_SETTINGS = ['support_verbosity', 'supports_search_tool', 'supports_reasoning_effort_updates', 'supports_reasoning_summary_parameter', 'supports_reasoning_summaries'] as const;
type CodexModelSettings = Partial<Record<typeof CODEX_STRING_SETTINGS[number], string | null>> & Partial<Record<typeof CODEX_BOOLEAN_SETTINGS[number], boolean>> & {
  experimental_supported_tools?: string[];
  service_tiers?: { id: string; name: string; description: string }[];
};

export interface ChatGPTCodexModelMetadata extends CodexModelSettings {
  context_window: number;
  max_context_window?: number;
}

export interface ChatGPTRawModel {
  codex?: CodexModelSettings;
  id: string;
  display_name: string;
  // The default and config-override ceiling are separate client settings.
  // https://github.com/openai/codex/blob/15fd656ddb55bd82a208fb9f00681880523f5260/codex-rs/models-manager/src/model_info.rs#L19-L31
  context_window: number;
  max_context_window?: number;
  // Preserve upstream additions independently of Floway's supported inputs.
  // https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/protocol/src/openai_models.rs#L178-L185
  input_modalities?: readonly string[];
  reasoning_efforts?: readonly string[];
  default_reasoning_effort?: string;
  // Codex selects the wire representation from catalog metadata, not the slug.
  // https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/protocol/src/openai_models.rs#L458-L463
  use_responses_lite?: boolean;
  image_detail_original?: boolean;
}

// `fetcher` is required so the catalog refresh traverses the same proxy/
// dial chain configured for request-time traffic. A null account id omits the
// header entirely — the upstream reads an absent header as "whichever account
// this bearer belongs to", where an empty one is a malformed value.
export const fetchChatGPTCatalog = async (opts: { accessToken: string; accountId: string | null; signal?: AbortSignal; fetcher: Fetcher }): Promise<ChatGPTRawModel[]> => {
  const response = await opts.fetcher(`${CHATGPT_BACKEND_BASE}${CHATGPT_MODELS_PATH}?client_version=${CHATGPT_CLI_VERSION}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      ...(opts.accountId === null ? {} : { 'chatgpt-account-id': opts.accountId }),
      originator: CHATGPT_ORIGINATOR,
      'user-agent': CHATGPT_USER_AGENT,
      version: CHATGPT_CLI_VERSION,
      accept: 'application/json',
    },
    signal: opts.signal,
  });
  if (!response.ok) {
    throw new ProviderModelsUnavailableError({ status: response.status, headers: new Headers(response.headers), body: await response.text() });
  }
  const parsed = await response.json() as { models?: unknown };
  if (!Array.isArray(parsed.models)) throw new Error('ChatGPT /models response missing models array');
  return parsed.models.map(assertRawModel);
};

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const readCodexModelSettings = (value: unknown, id: string): CodexModelSettings | undefined => {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw new TypeError(`ChatGPT model ${id} Codex metadata must be an object`);
  const settings: CodexModelSettings = {};
  for (const key of CODEX_STRING_SETTINGS) {
    const setting = value[key];
    if (setting === undefined) continue;
    if (setting !== null && (typeof setting !== 'string' || !setting)) throw new TypeError(`ChatGPT model ${id} ${key} malformed`);
    settings[key] = setting;
  }
  for (const key of CODEX_BOOLEAN_SETTINGS) {
    const setting = value[key];
    if (setting === undefined) continue;
    if (typeof setting !== 'boolean') throw new TypeError(`ChatGPT model ${id} ${key} malformed`);
    settings[key] = setting;
  }
  const tools = value.experimental_supported_tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools) || !tools.every((tool): tool is string => typeof tool === 'string' && tool.length > 0)) {
      throw new TypeError(`ChatGPT model ${id} experimental_supported_tools malformed`);
    }
    settings.experimental_supported_tools = tools;
  }
  const legacy = value.additional_speed_tiers;
  if (legacy !== undefined && (!Array.isArray(legacy) || !legacy.every(tier => typeof tier === 'string' && tier.length > 0))) {
    throw new TypeError(`ChatGPT model ${id} additional_speed_tiers malformed`);
  }
  const tiers = value.service_tiers;
  if (tiers !== undefined) {
    if (!Array.isArray(tiers)) throw new TypeError(`ChatGPT model ${id} service_tiers malformed`);
    settings.service_tiers = tiers.map((tier: unknown) => {
      if (!isPlainRecord(tier) || typeof tier.id !== 'string' || !tier.id || typeof tier.name !== 'string' || typeof tier.description !== 'string') {
        throw new TypeError(`ChatGPT model ${id} service_tiers entry malformed`);
      }
      return { id: tier.id, name: tier.name, description: tier.description };
    });
  } else if (Array.isArray(legacy)) {
    // Codex only recognizes "fast" in the legacy field; its request value is "priority".
    // https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/protocol/src/openai_models.rs#L1122-L1143
    settings.service_tiers = legacy.includes('fast') ? [{ id: 'priority', name: 'Fast', description: '' }] : [];
  }
  return Object.keys(settings).length ? settings : undefined;
};

const assertContextWindow = (value: unknown, id: string, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`ChatGPT model entry ${id} ${field} must be a positive safe integer`);
  }
  return value;
};

// Optional capabilities follow the upstream schema; malformed values expose
// contract drift instead of silently changing the advertised model behavior.
const assertRawModel = (value: unknown): ChatGPTRawModel => {
  if (!isPlainRecord(value)) throw new TypeError('ChatGPT model entry is not an object');
  const slug = value.slug;
  if (typeof slug !== 'string') throw new TypeError('ChatGPT model entry missing slug');
  const display_name = value.display_name;
  if (typeof display_name !== 'string') throw new TypeError(`ChatGPT model entry ${slug} missing display_name`);
  const context_window = assertContextWindow(value.context_window, slug, 'context_window');

  const raw: ChatGPTRawModel = { id: slug, display_name, context_window };
  const codex = readCodexModelSettings(value, slug);
  if (codex !== undefined) raw.codex = codex;
  if (value.max_context_window !== undefined && value.max_context_window !== null) {
    raw.max_context_window = assertContextWindow(value.max_context_window, slug, 'max_context_window');
  }

  if (value.input_modalities !== undefined) {
    if (!Array.isArray(value.input_modalities)) throw new TypeError(`ChatGPT model entry ${slug} input_modalities not an array`);
    const out: string[] = [];
    for (const m of value.input_modalities) {
      if (typeof m !== 'string' || m.length === 0) throw new TypeError(`ChatGPT model entry ${slug} input_modalities entry must be a non-empty string`);
      if (!out.includes(m)) out.push(m);
    }
    raw.input_modalities = out;
  }

  if (value.supported_reasoning_levels !== undefined) {
    if (!Array.isArray(value.supported_reasoning_levels)) throw new TypeError(`ChatGPT model entry ${slug} supported_reasoning_levels not an array`);
    const efforts: string[] = [];
    for (const entry of value.supported_reasoning_levels) {
      if (!isPlainRecord(entry) || typeof entry.effort !== 'string' || entry.effort.length === 0) {
        throw new TypeError(`ChatGPT model entry ${slug} reasoning level entry malformed`);
      }
      if (!efforts.includes(entry.effort)) efforts.push(entry.effort);
    }
    raw.reasoning_efforts = efforts;
  }

  if (value.supports_image_detail_original !== undefined) {
    if (typeof value.supports_image_detail_original !== 'boolean') {
      throw new TypeError(`ChatGPT model entry ${slug} supports_image_detail_original not a boolean`);
    }
    raw.image_detail_original = value.supports_image_detail_original;
  }

  if (value.default_reasoning_level !== undefined) {
    if (typeof value.default_reasoning_level !== 'string' || value.default_reasoning_level.length === 0) {
      throw new TypeError(`ChatGPT model entry ${slug} default_reasoning_level malformed`);
    }
    raw.default_reasoning_effort = value.default_reasoning_level;
  }

  if (value.use_responses_lite !== undefined) {
    if (typeof value.use_responses_lite !== 'boolean') {
      throw new TypeError(`ChatGPT model entry ${slug} use_responses_lite not a boolean`);
    }
    raw.use_responses_lite = value.use_responses_lite;
  }

  return raw;
};

export const chatgptCodexModelMetadata = (model: Pick<ProviderModel, 'id' | 'limits' | 'providerData'>): ChatGPTCodexModelMetadata => {
  if (!isPlainRecord(model.providerData)) {
    throw new TypeError(`ChatGPT model ${model.id} providerData is not an object`);
  }
  return {
    ...readCodexModelSettings(model.providerData.codex, model.id),
    context_window: assertContextWindow(model.providerData.contextWindow, model.id, 'providerData.contextWindow'),
    ...(model.limits.max_context_window_tokens === undefined
      ? {}
      : { max_context_window: model.limits.max_context_window_tokens }),
  };
};

export const chatgptModelUsesResponsesLite = (model: Pick<ProviderModel, 'id' | 'providerData'>): boolean => {
  const providerData = model.providerData;
  if (providerData === undefined) return false;
  if (!isPlainRecord(providerData)) {
    throw new TypeError(`ChatGPT model ${model.id} providerData is not an object`);
  }
  const value = providerData.useResponsesLite;
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new TypeError(`ChatGPT model ${model.id} providerData.useResponsesLite is not a boolean`);
  }
  return value;
};

// Every entry returned by the remote ChatGPT catalog is an OpenAI Responses chat model.
// Pricing is looked up from the per-slug table in pricing.ts so the dashboard
// can report a notional API-rate price even though ChatGPT bills as a
// flat-fee subscription. Provider-owned models such as gpt-image-2 are added
// separately and never pass through this mapper.
//
// `enabledFlags` is the upstream-resolved flag set (provider defaults
// merged with the row's `flagOverrides`); it propagates per-model so
// downstream pipeline stages can read the effective set without re-resolving.
export const chatgptRawToProviderModel = (raw: ChatGPTRawModel, enabledFlags: ReadonlySet<FlagId>): ProviderModel => {
  const contextWindow = assertContextWindow(raw.context_window, raw.id, 'context_window');
  const maxContextWindow = raw.max_context_window === undefined
    ? undefined
    : assertContextWindow(raw.max_context_window, raw.id, 'max_context_window');
  if (maxContextWindow !== undefined && contextWindow > maxContextWindow) {
    throw new RangeError(`ChatGPT model ${raw.id} context_window exceeds max_context_window`);
  }
  if (raw.use_responses_lite !== undefined && typeof raw.use_responses_lite !== 'boolean') {
    throw new TypeError(`ChatGPT model entry ${raw.id} use_responses_lite not a boolean`);
  }
  const pricing = pricingForChatGPTModelKey(raw.id);
  const chat: UpstreamChatModelConfig = {};
  const input = raw.input_modalities?.filter(modality => modality === 'text' || modality === 'image' || modality === 'audio');
  if (input !== undefined) {
    chat.modalities = { input, output: ['text'] };
  }
  // Resolve the capability to a stated boolean for every entry. The remote
  // provider catalog owns this fact, so we treat an omitted field as unsupported
  // rather than inherit from a same-named client-catalog entry. `ModelInfo`
  // declares the field under `#[serde(default)]`
  // (https://github.com/openai/codex/blob/f66d793a2d78287c8c28a5f41f39c58ac49bcc25/codex-rs/protocol/src/openai_models.rs#L383-L385),
  // so a catalog that predates the field carries none and is treated as false.
  chat.image_detail_original = raw.image_detail_original ?? false;
  if (raw.reasoning_efforts && raw.reasoning_efforts.length > 0) {
    let effortDefault: string;
    if (raw.default_reasoning_effort !== undefined) {
      if (!raw.reasoning_efforts.includes(raw.default_reasoning_effort)) {
        throw new Error(`ChatGPT model ${raw.id}: default_reasoning_level not in supported_reasoning_levels`);
      }
      effortDefault = raw.default_reasoning_effort;
    } else {
      effortDefault = raw.reasoning_efforts.includes('medium') ? 'medium' : raw.reasoning_efforts[0]!;
    }
    chat.reasoning = { effort: { supported: raw.reasoning_efforts, default: effortDefault } };
  }
  return {
    id: raw.id,
    upstreamModelId: raw.id,
    display_name: raw.display_name,
    owned_by: 'openai',
    kind: 'chat',
    limits: {
      ...(maxContextWindow === undefined ? {} : { max_context_window_tokens: maxContextWindow }),
    },
    endpoints: { openaiResponses: {} },
    providerData: {
      contextWindow,
      ...(raw.codex === undefined ? {} : { codex: raw.codex }),
      useResponsesLite: raw.use_responses_lite ?? false,
    } satisfies ChatGPTProviderData,
    enabledFlags,
    opaqueBlobCompatibilityScope: { bindToUpstream: true, key: 'openai' },
    ...(pricing ? { pricing } : {}),
    ...(Object.keys(chat).length > 0 ? { chat } : {}),
  };
};

// CLIProxyAPI exposes Codex's built-in image models for every plan, then
// rejects image dispatch only when the JWT plan is explicitly `free`; missing
// and future plan values fail open. Mirror that account-eligibility rule here
// while keeping the image model outside the remote chat-model catalog.
// https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/internal/runtime/executor/codex_executor_request.go#L381-L449
// https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/sdk/cliproxy/auth/conductor_execution.go#L1036-L1066
export const chatgptPlanSupportsImages = (planType: string | undefined): boolean =>
  planType?.trim().toLowerCase() !== 'free';

export const chatgptImageProviderModel = (enabledFlags: ReadonlySet<FlagId>): ProviderModel => ({
  id: CHATGPT_IMAGE_MODEL_ID,
  upstreamModelId: CHATGPT_IMAGE_MODEL_ID,
  display_name: 'GPT-Image-2',
  owned_by: 'openai',
  kind: 'image',
  limits: {},
  endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} },
  enabledFlags,
  opaqueBlobCompatibilityScope: { bindToUpstream: true, key: 'openai' },
  pricing: GPT_IMAGE_2_PRICING,
});
