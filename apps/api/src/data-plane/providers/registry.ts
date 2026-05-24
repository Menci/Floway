import { createAzureProvider } from './azure/provider.ts';
import { createCopilotProvider } from './copilot/provider.ts';
import { createCustomProvider } from './custom/provider.ts';
import { kindForEndpoints } from './endpoints.ts';
import type { InternalModel, ModelProviderInstance, ProviderModelRecord, ResolvedModel, UpstreamModel } from './types.ts';
import { getRepo } from '../../repo/index.ts';
import type { UpstreamProviderKind, UpstreamRecord } from '../../repo/types.ts';
import type { ModelEndpoint } from '@floway-dev/protocols/common';

interface ProviderModelsResult {
  models: ResolvedModel[];
  sawSuccess: boolean;
  lastError: unknown;
}

type ProviderFactory = (record: UpstreamRecord) => ModelProviderInstance | Promise<ModelProviderInstance>;

const providerFactories: Record<UpstreamProviderKind, ProviderFactory> = {
  copilot: createCopilotProvider,
  custom: createCustomProvider,
  azure: createAzureProvider,
};

// Ids not in the catalog are silently dropped; undefined/null preserves global sort order.
export const listModelProviders = async (upstreamFilter?: readonly string[] | null): Promise<ModelProviderInstance[]> => {
  const upstreams = await getRepo().upstreams.list();
  const enabledById = new Map<string, UpstreamRecord>();
  for (const upstream of upstreams) {
    if (upstream.enabled) enabledById.set(upstream.id, upstream);
  }

  const selection: UpstreamRecord[] = upstreamFilter
    ? upstreamFilter.map(id => enabledById.get(id)).filter((u): u is UpstreamRecord => u !== undefined)
    : [...enabledById.values()];

  const providers: ModelProviderInstance[] = [];
  for (const upstream of selection) {
    providers.push(await providerFactories[upstream.provider](upstream));
  }

  return providers;
};

const unionEndpoints = (a: readonly ModelEndpoint[], b: readonly ModelEndpoint[]): ModelEndpoint[] => {
  const result = [...a];
  for (const endpoint of b) {
    if (!result.includes(endpoint)) result.push(endpoint);
  }
  return result;
};

const resolvedFromUpstreamModel = (upstreamModel: UpstreamModel, record: ProviderModelRecord): ResolvedModel => {
  const { providerData: _providerData, upstreamEndpoints, ...internal } = upstreamModel;
  return {
    ...internal,
    upstreamEndpoints: [...upstreamEndpoints],
    providers: [record],
  };
};

const collectProviderModels = async (providers: readonly ModelProviderInstance[]): Promise<ProviderModelsResult> => {
  const byId = new Map<string, ResolvedModel>();
  let sawSuccess = false;
  let lastError: unknown = null;

  for (const instance of providers) {
    try {
      const providedModels = await instance.provider.getProvidedModels();
      sawSuccess = true;
      for (const upstreamModel of providedModels) {
        if (!upstreamModel.id) continue;
        const record: ProviderModelRecord = {
          upstream: instance.upstream,
          upstreamName: instance.name,
          providerKind: instance.providerKind,
          provider: instance.provider,
          upstreamModel,
          enabledFlags: upstreamModel.enabledFlags,
          sourceInterceptors: instance.sourceInterceptors,
          targetInterceptors: instance.targetInterceptors,
        };
        const existing = byId.get(upstreamModel.id);
        if (!existing) {
          byId.set(upstreamModel.id, resolvedFromUpstreamModel(upstreamModel, record));
          continue;
        }

        // Known limitation for this refactor: when multiple providers expose
        // the same public model id, the first provider's metadata remains the
        // public /models metadata. Runtime execution still uses the selected
        // provider's own UpstreamModel, so capability-sensitive calls do not
        // depend on this merged view being perfectly representative.
        const upstreamEndpoints = unionEndpoints(existing.upstreamEndpoints, upstreamModel.upstreamEndpoints);
        byId.set(upstreamModel.id, {
          ...existing,
          upstreamEndpoints,
          kind: kindForEndpoints(upstreamEndpoints),
          providers: [...existing.providers, record],
        });
      }
    } catch (error) {
      lastError = error;
    }
  }

  return { models: [...byId.values()], sawSuccess, lastError };
};

const modelWithProviderInstances = (model: ResolvedModel, providers: ReadonlySet<ModelProviderInstance>): ResolvedModel => {
  const providerInstances = [...providers];
  const bindings = model.providers.filter(binding => providerInstances.some(instance => instance.upstream === binding.upstream && instance.provider === binding.provider));
  const upstreamEndpoints = bindings.reduce<ModelEndpoint[]>((endpoints, binding) => unionEndpoints(endpoints, binding.upstreamModel.upstreamEndpoints), []);

  return {
    ...model,
    upstreamEndpoints,
    kind: kindForEndpoints(upstreamEndpoints),
    providers: bindings,
  };
};

// Public-facing model-id ordering, applied in getModels() to every list that
// crosses a gateway boundary (data-plane /v1/models, /models, /v1beta/models
// and the control-plane /api/models that backs the dashboard models page).
// Provider upstreams return models in arbitrary order; sorting here gives the
// dashboard and downstream clients a stable, family-grouped view.
//
// Sort keys, evaluated in order:
//   0. Whether the id contains a '/'. Slashed ids (Microsoft Foundry router
//      model ids like "accounts/msft/routers/x") are pushed to the tail so
//      the typical flat ids stay on top.
//   1. Leading [a-zA-Z]+ prefix, case-insensitive, ascending. Groups model
//      families: "claude-haiku-4-5" -> "claude", "deepseek-v4-pro" ->
//      "deepseek".
//   2. Array of isolated single digits (a digit surrounded on both sides by a
//      non-digit, with start/end of string counting as non-digit), compared
//      element by element as integers, DESCENDING — newer/larger versions
//      first: "claude-opus-4-7" -> [4, 7] beats "claude-opus-4-5" -> [4, 5];
//      "gpt-5.5" -> [5, 5] beats "gpt-4o" -> [4]. Multi-digit runs (dates,
//      "20300101") are intentionally not counted as version parts.
//   3. Full string lex order, DESCENDING, case-folded first then raw — keeps
//      "GPT-4o" and "gpt-4o" adjacent while giving longer/later suffixes
//      priority within an otherwise tied group.
export const compareModelIds = (a: string, b: string): number => {
  const cmp = <T>(x: T, y: T, dir = 1) => (x < y ? -dir : x > y ? dir : 0);
  const prefix = (s: string) => /^[a-zA-Z]+/.exec(s)?.[0].toLowerCase() ?? '';
  const digits = (s: string) => [...s.matchAll(/(?<!\d)\d(?!\d)/g)].map(m => +m[0]);
  const [da, db] = [digits(a), digits(b)];
  return cmp(+a.includes('/'), +b.includes('/'))
    || cmp(prefix(a), prefix(b))
    || (da.slice(0, Math.min(da.length, db.length)).map((v, i) => db[i] - v).find(d => d !== 0) ?? db.length - da.length)
    || cmp(a.toLowerCase(), b.toLowerCase(), -1)
    || cmp(a, b, -1);
};

export const getModels = async (upstreamFilter?: readonly string[] | null): Promise<ResolvedModel[]> => {
  const providers = await listModelProviders(upstreamFilter);
  if (providers.length === 0) {
    throw new Error('No upstream provider configured — connect GitHub Copilot or add a Custom/Azure upstream in the dashboard');
  }

  const { models, sawSuccess, lastError } = await collectProviderModels(providers);

  if (sawSuccess) return [...models].sort((a, b) => compareModelIds(a.id, b.id));
  if (lastError) throw lastError;
  return [];
};

// Strips planner-only and provider-binding fields, leaving the InternalModel
// shape consumed by the public /models DTO projection and the dashboard.
export const getInternalModels = async (upstreamFilter?: readonly string[] | null): Promise<InternalModel[]> =>
  (await getModels(upstreamFilter)).map(({ providers: _providers, upstreamEndpoints: _upstreamEndpoints, ...model }) => model);

export interface ModelResolution {
  id: string;
  model?: ResolvedModel;
}

const resolveProviderAlias = (providers: readonly ModelProviderInstance[], byId: ReadonlyMap<string, ResolvedModel>, modelId: string): ResolvedModel | undefined => {
  let resolved: ResolvedModel | undefined;
  const providersForAlias = new Set<ModelProviderInstance>();

  for (const instance of providers) {
    const aliasTarget = instance.resolveRequestedModelId?.(modelId);
    if (!aliasTarget || aliasTarget === modelId) continue;

    const model = byId.get(aliasTarget);
    if (!model) continue;
    if (resolved && resolved.id !== model.id) continue;

    const providerHasModel = model.providers.some(binding => binding.upstream === instance.upstream && binding.provider === instance.provider);
    if (!providerHasModel) continue;

    resolved = model;
    providersForAlias.add(instance);
  }

  if (!resolved) return undefined;
  return modelWithProviderInstances(resolved, providersForAlias);
};

export const resolveModelForRequest = async (modelId: string, upstreamFilter?: readonly string[] | null): Promise<ModelResolution> => {
  const providers = await listModelProviders(upstreamFilter);
  if (providers.length === 0) {
    throw new Error('No upstream provider configured — connect GitHub Copilot or add a Custom/Azure upstream in the dashboard');
  }

  const { models, lastError } = await collectProviderModels(providers);
  const byId = new Map(models.map(model => [model.id, model]));

  const exact = byId.get(modelId);
  if (exact) return { id: exact.id, model: exact };

  const alias = resolveProviderAlias(providers, byId, modelId);
  if (alias) return { id: alias.id, model: alias };

  if (lastError) throw lastError;

  return { id: modelId };
};
