import type { KimiCodeUpstreamConfig } from './config.ts';
import { kimiCodeFetch } from './fetch.ts';
import { publicKimiCodeModelId } from './public-model-id.ts';
import { object, string, number } from './validation.ts';
import { fetchUpstreamModels, identityWrapUpstreamCall, ProviderModelsUnavailableError, type Fetcher, type FlagId, type ProviderModel } from '@floway-dev/provider';

// Capability and effort metadata are authoritative; display names affect only
// public presentation ids through publicKimiCodeModelId. Only catalog ids are
// sent upstream: unknown K2 ids silently run the default model while echoing
// the invented id; K3 ids are validated by the service.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/auth/platforms.py#L27-L50
const projectCatalog = (value: unknown, enabledFlags: ReadonlySet<FlagId>): ProviderModel[] => {
  const body = object(value, 'Kimi Code models');
  if (!Array.isArray(body.data)) throw new TypeError('Kimi Code models.data must be an array');
  return body.data.flatMap(value => {
    const raw = object(value, 'Kimi Code model');
    const upstreamModelId = string(raw.id, 'Kimi Code model.id');
    const displayName = string(raw.display_name, 'Kimi Code model.display_name');
    const id = publicKimiCodeModelId(upstreamModelId, displayName);
    if (id === null) {
      console.warn('Skipping Kimi Code model with an unrecognized display name:', upstreamModelId, displayName);
      return [];
    }
    const chat: NonNullable<ProviderModel['chat']> = {
      modalities: { input: raw.supports_image_in === true ? ['text', 'image'] : ['text'], output: ['text'] },
    };
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
      providerData: upstreamModelId,
      enabledFlags,
      chat,
      opaqueBlobCompatibilityScope: { bindToUpstream: true },
    } satisfies ProviderModel;
  });
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
