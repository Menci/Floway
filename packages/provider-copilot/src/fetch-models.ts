import { copilotFetchModels, type CopilotFetchConfig } from './fetch.ts';
import type { CopilotModelsResponse } from './types.ts';
import { fetchUpstreamModels, type Fetcher, identityWrapUpstreamCall } from '@floway-dev/provider';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';
const isOptionalBoolean = (value: unknown): boolean => value === undefined || typeof value === 'boolean';
const isOptionalFiniteNonNegativeNumber = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
const isOptionalStringArray = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.every(item => typeof item === 'string'));

const isCopilotRawModel = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return false;
  if (!isOptionalString(value.name)
    || !isOptionalString(value.version)
    || !isOptionalString(value.owned_by)
    || !isOptionalString(value.display_name)
    || !isOptionalFiniteNonNegativeNumber(value.created)
    || !isOptionalStringArray(value.supported_endpoints)) return false;

  if (value.capabilities === undefined) return true;
  if (!isRecord(value.capabilities) || !isOptionalString(value.capabilities.type)) return false;

  const limits = value.capabilities.limits;
  if (limits !== undefined) {
    if (!isRecord(limits)
      || !isOptionalFiniteNonNegativeNumber(limits.max_context_window_tokens)
      || !isOptionalFiniteNonNegativeNumber(limits.max_prompt_tokens)
      || !isOptionalFiniteNonNegativeNumber(limits.max_output_tokens)) return false;
  }

  const supports = value.capabilities.supports;
  return supports === undefined || (
    isRecord(supports)
    && isOptionalBoolean(supports.vision)
    && isOptionalStringArray(supports.reasoning_effort)
    && isOptionalFiniteNonNegativeNumber(supports.min_thinking_budget)
    && isOptionalFiniteNonNegativeNumber(supports.max_thinking_budget)
    && isOptionalBoolean(supports.adaptive_thinking)
  );
};

const isCopilotModelsResponse = (value: unknown): value is CopilotModelsResponse => {
  if (!isRecord(value) || typeof value.object !== 'string' || !Array.isArray(value.data)) return false;
  const ids = new Set<string>();
  for (const model of value.data) {
    if (!isCopilotRawModel(model)) return false;
    const id = (model as { id: string }).id;
    if (ids.has(id)) return false;
    ids.add(id);
  }
  return true;
};

// VSCode Copilot Chat tags `/models` calls with the `model-access` intent
// instead of the generic `conversation-agent` one used for generation calls,
// and omits `Content-Type` since the request has no body. Probing both header
// sets returned byte-identical bodies and policy headers, so the only
// motivation is semantic alignment with VSCode's wire shape.
//
// Reference (caozhiyuan/copilot-api uses the same split):
// https://github.com/caozhiyuan/copilot-api/blob/dc3d4aaf249d534bc66d5f1cb221ac29489b9753/src/lib/api-config.ts
const MODELS_HEADER_OVERRIDES = new Headers({
  'openai-intent': 'model-access',
  'x-interaction-type': 'model-access',
  'content-type': '',
});

export const fetchCopilotModels = (config: CopilotFetchConfig, fetcher: Fetcher): Promise<CopilotModelsResponse> =>
  fetchUpstreamModels(
    () => copilotFetchModels(config, { method: 'GET' }, { extraHeaders: MODELS_HEADER_OVERRIDES, fetcher, wrapUpstreamCall: identityWrapUpstreamCall }),
    v => (isCopilotModelsResponse(v) ? v : null),
  );
