import type { KimiCodeUpstreamConfig } from './config.ts';
import { kimiCodeFetch } from './fetch.ts';
import type { KimiCodeProviderData } from './model-selection.ts';
import { parseKimiCodeModelName, publicKimiCodeModelId } from './public-model-id.ts';
import { object, string, number } from './validation.ts';
import { fetchUpstreamModels, identityWrapUpstreamCall, ProviderModelsUnavailableError, type Fetcher, type FlagId, type ProviderModel } from '@floway-dev/provider';

// Capability and effort metadata are authoritative; display names establish
// public presentation ids and model-version identity. Only catalog ids are
// sent upstream: unknown K2 ids silently run the default model while echoing
// the invented id; K3 ids are validated by the service.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/auth/platforms.py#L27-L50
// Context-capped variants are not published. `k3-256k` is `k3` at a 256K cap,
// and a plan without the 1M grant receives `k3` at that cap anyway, so the
// variant reaches no capability the fuller id cannot. Measured against a live
// account, equal prompt sizes consumed the same quota through either id, so
// the documented 2x cost of `k3` did not apply below the cap either.
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
      providerData: (upstreamModelId.endsWith('-highspeed') ? { fastModelId: upstreamModelId } : { standardModelId: upstreamModelId }) satisfies KimiCodeProviderData,
      enabledFlags,
      chat: { ...chat, modalities },
      opaqueBlobCompatibilityScope: { bindToUpstream: true },
    } satisfies ProviderModel;
  });
  const standardByPublicId = new Map(models.filter(model => !model.upstreamModelId.endsWith('-highspeed')).map(model => [model.id, model]));
  const fastByBaseId = new Map<string, (typeof models)[number]>();
  for (const model of models) {
    // The suffix alone is not model identity: kimi-for-coding is K2.8 Preview,
    // but kimi-for-coding-highspeed is K2.7 Code. Pair only matching versions,
    // or a fast request would silently switch the model generation.
    // https://www.kimi.com/code/docs/en/kimi-code/models.html
    if (!model.upstreamModelId.endsWith('-highspeed')) continue;
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
  return families;
};

export const fetchKimiCodeModels = (config: KimiCodeUpstreamConfig, fetcher: Fetcher, enabledFlags: ReadonlySet<FlagId>): Promise<ProviderModel[]> =>
  fetchUpstreamModels(
    () => kimiCodeFetch(config, '/models', { method: 'GET' }, { fetcher, wrapUpstreamCall: identityWrapUpstreamCall }),
    value => {
      try {
        return projectCatalog(value, enabledFlags);
      } catch (cause) {
        throw new ProviderModelsUnavailableError(null, cause);
      }
    },
  );
