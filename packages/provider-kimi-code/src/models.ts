import { assertKimiCodeUpstreamRecord, type KimiCodeUpstreamConfig } from './config.ts';
import { KIMI_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { kimiCodeEndpoint } from './endpoints.ts';
import type { KimiCodeProviderData } from './model-selection.ts';
import { pricingForKimiCodePublicModelId } from './pricing.ts';
import { kimiCodeModelLabel, parseKimiCodeModelName, publicKimiCodeModelId } from './public-model-id.ts';
import { object, string, number } from './validation.ts';
import { fetchUpstreamModels, ProviderModelsUnavailableError, resolveEffectiveFlags, type Fetcher, type FlagId, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';

// Capability and effort metadata are authoritative; display names establish
// public presentation ids and model-version identity. Only catalog ids are
// sent upstream: documentation describes a mistyped-id fallback to K2.8 Preview
// without thinking. In observed chat generation, a nonexistent kimi- id succeeded
// and echoed the id, while a nonexistent k3- id was rejected. count_tokens
// accepted both.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/auth/platforms.py#L27-L50
// We withhold context-capped variants as a catalog presentation policy. The
// documented 256K variant differs in context and quota cost; hiding it is not
// a claim that its billing or capabilities equal the uncapped model.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
const isContextCappedVariant = (publicId: string): boolean => publicId.endsWith('-256k');

const projectCatalog = (value: unknown, enabledFlags: ReadonlySet<FlagId>): ProviderModel[] => {
  const body = object(value, 'Kimi Code models');
  if (!Array.isArray(body.data)) throw new TypeError('Kimi Code models.data must be an array');
  const models = body.data.flatMap(value => {
    const raw = object(value, 'Kimi Code model');
    const upstreamModelId = string(raw.id, 'Kimi Code model.id');
    const displayName = string(raw.display_name, 'Kimi Code model.display_name');
    const id = publicKimiCodeModelId(upstreamModelId, displayName);
    if (id === null) {
      console.warn('Skipping Kimi Code model with an unrecognized display name:', upstreamModelId, displayName);
      return [];
    }
    if (isContextCappedVariant(id)) return [];
    const modalities: NonNullable<NonNullable<ProviderModel['chat']>['modalities']> = { input: raw.supports_image_in === true ? ['text', 'image'] : ['text'], output: ['text'] };
    const chat: NonNullable<ProviderModel['chat']> = { modalities };
    if (raw.supports_reasoning === true) {
      chat.reasoning = { mandatory: raw.supports_thinking_type === 'only' };
      if (raw.think_efforts !== undefined) {
        const efforts = object(raw.think_efforts, 'Kimi Code think_efforts');
        if (efforts.support === true) {
          if (!Array.isArray(efforts.valid_efforts)) throw new TypeError('Kimi Code valid_efforts must be an array');
          const supported = efforts.valid_efforts.map(value => string(value, 'Kimi Code effort'));
          const defaultEffort = string(efforts.default_effort, 'Kimi Code default_effort');
          if (!supported.includes(defaultEffort)) throw new TypeError('Kimi Code default_effort must belong to valid_efforts');
          chat.reasoning.effort = { supported, default: defaultEffort };
        }
      }
    }
    const providerData: KimiCodeProviderData = upstreamModelId.endsWith('-highspeed') ? { fastModelId: upstreamModelId } : { standardModelId: upstreamModelId };
    return {
      id,
      upstreamModelId,
      display_name: displayName,
      ...(raw.created !== undefined ? { created: number(raw.created, 'Kimi Code model.created') } : {}),
      owned_by: 'kimi',
      limits: { max_context_window_tokens: number(raw.context_length, 'Kimi Code model.context_length') },
      kind: 'chat',
      endpoints: { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} },
      // The catalog has no standard-speed K2.7 Code: its sole Highspeed row
      // remains honest under a speed-free public id only with a fast selector.
      // https://www.kimi.com/code/docs/en/kimi-code/models.html
      providerData,
      enabledFlags,
      chat: { ...chat, modalities },
      opaqueBlobCompatibilityScope: { bindToUpstream: true },
    } satisfies ProviderModel;
  });
  const standardByPublicId = new Map(models.filter(model => model.providerData.standardModelId !== undefined).map(model => [model.id, model]));
  const fastByBaseId = new Map<string, (typeof models)[number]>();
  for (const model of models) {
    // The suffix alone is not model identity: kimi-for-coding is K2.8 Preview,
    // but kimi-for-coding-highspeed is K2.7 Code. Pair only matching versions,
    // or a fast request would silently switch the model generation.
    // https://www.kimi.com/code/docs/en/kimi-code/models.html
    if (model.providerData.fastModelId === undefined) continue;
    const base = standardByPublicId.get(model.id);
    const name = parseKimiCodeModelName(model.display_name);
    const baseName = base === undefined ? null : parseKimiCodeModelName(base.display_name);
    if (base !== undefined && name !== null && baseName !== null && name.version === baseName.version && name.family === baseName.family) fastByBaseId.set(base.upstreamModelId, model);
  }
  const fastIds = new Set([...fastByBaseId.values()].map(model => model.upstreamModelId));
  const families = models.filter(model => !fastIds.has(model.upstreamModelId)).map(base => {
    const fast = fastByBaseId.get(base.upstreamModelId);
    if (fast === undefined) return base;
    return {
      ...base,
      limits: { max_context_window_tokens: Math.min(base.limits.max_context_window_tokens, fast.limits.max_context_window_tokens) },
      chat: {
        ...base.chat,
        modalities: {
          input: base.chat.modalities.input.filter(modality => fast.chat.modalities.input.includes(modality)),
          output: base.chat.modalities.output.filter(modality => fast.chat.modalities.output.includes(modality)),
        },
      },
      providerData: { standardModelId: base.upstreamModelId, fastModelId: fast.upstreamModelId } satisfies KimiCodeProviderData,
    };
  });
  const publicIds = new Set<string>();
  for (const family of families) {
    if (publicIds.has(family.id)) throw new TypeError(`Kimi Code catalog contains conflicting model families: ${family.id}`);
    publicIds.add(family.id);
  }
  if (families.length === 0) throw new TypeError('Kimi Code catalog contains no publishable models');
  return families.map(model => {
    const pricing = pricingForKimiCodePublicModelId(model.id);
    return { ...model, display_name: kimiCodeModelLabel(model.display_name), ...(pricing === null ? {} : { pricing }) };
  });
};

const fetchKimiCodeModels = (config: KimiCodeUpstreamConfig, fetcher: Fetcher, enabledFlags: ReadonlySet<FlagId>): Promise<ProviderModel[]> =>
  fetchUpstreamModels(
    () => fetcher(kimiCodeEndpoint(config.region, '/models'), { method: 'GET', headers: [['authorization', `Bearer ${config.apiKey}`]] }),
    value => {
      try {
        return projectCatalog(value, enabledFlags);
      } catch (cause) {
        throw new ProviderModelsUnavailableError(null, cause);
      }
    },
  );

export const getKimiCodeProvidedModels = (record: UpstreamRecord, fetcher: Fetcher): Promise<ProviderModel[]> =>
  fetchKimiCodeModels(assertKimiCodeUpstreamRecord(record).config, fetcher, resolveEffectiveFlags([KIMI_CODE_DEFAULT_FLAGS, record.flagOverrides]));
