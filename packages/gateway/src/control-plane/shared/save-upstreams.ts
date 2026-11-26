import { HTTPException } from 'hono/http-exception';

import { flagDefaultsForKind } from '../../data-plane/providers/registry.ts';
import { getRepo } from '../../repo/index.ts';
import { isModelsCacheDue, MODEL_CATALOG_REVISION } from '../../repo/models-cache-contract.ts';
import type { StoredUpstreamRecord, UpstreamModelEntry, UpstreamModelsWritePayload } from '../../repo/types.ts';
import { serializeStoredConfig, serializeStoredState } from '../../repo/upstream-json.ts';
import { scheduleUpstreamModelsRefresh, supportsManualModels, upstreamRequiresNetworkForModels } from '../../upstreams/models-refresh.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { resolveEffectiveFlags, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/provider';
import { projectAzureModels } from '@floway-dev/provider-azure';
import { assertCustomUpstreamRecord, projectCustomManualModels } from '@floway-dev/provider-custom';
import { assertOllamaUpstreamRecord, projectOllamaManualModels } from '@floway-dev/provider-ollama';

export interface SaveRefreshContext {
  readonly runtimeLocation: string | null;
  readonly scheduler: BackgroundScheduler;
}

export interface UpstreamChange {
  readonly previous: StoredUpstreamRecord | null;
  readonly next: UpstreamRecord;
  readonly manualModels?: readonly UpstreamModelConfig[];
  readonly refreshContext: SaveRefreshContext;
}

const sameRemoteConnection = (previous: UpstreamRecord, next: UpstreamRecord): boolean => {
  if (previous.kind !== next.kind) return false;
  if (previous.kind === 'custom') {
    const prevCfg = assertCustomUpstreamRecord(previous).config;
    const nextCfg = assertCustomUpstreamRecord(next).config;
    return prevCfg.baseUrl === nextCfg.baseUrl
      && prevCfg.apiKey === nextCfg.apiKey
      && serializeStoredConfig(prevCfg.endpoints) === serializeStoredConfig(nextCfg.endpoints)
      && serializeStoredConfig(prevCfg.modelsFetch) === serializeStoredConfig(nextCfg.modelsFetch);
  }
  if (previous.kind === 'ollama') {
    const prevCfg = assertOllamaUpstreamRecord(previous).config;
    const nextCfg = assertOllamaUpstreamRecord(next).config;
    return prevCfg.baseUrl === nextCfg.baseUrl && prevCfg.apiKey === nextCfg.apiKey;
  }
  return false;
};

const projectManualEntries = (
  record: UpstreamRecord,
  manualModels: readonly UpstreamModelConfig[],
): UpstreamModelEntry[] => {
  if (record.kind === 'azure') {
    return projectAzureModels(record, manualModels).map(model => ({ source: 'manual', model }));
  }
  if (record.kind === 'custom') {
    return projectCustomManualModels(record, manualModels).map(model => ({ source: 'manual', model }));
  }
  if (record.kind === 'ollama') {
    return projectOllamaManualModels(record, manualModels).map(model => ({ source: 'manual', model }));
  }
  return [];
};

const planInsertModelsWrite = (
  next: UpstreamRecord,
  manualModels: readonly UpstreamModelConfig[] | undefined,
): {
  readonly modelsWrite?: UpstreamModelsWritePayload;
  readonly needsBackgroundRefresh: boolean;
} => {
  const effectiveManual = manualModels ?? [];
  if (!upstreamRequiresNetworkForModels(next)) {
    return {
      modelsWrite: {
        models: projectManualEntries(next, effectiveManual),
        cacheAction: { kind: 'set-fresh', revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() },
      },
      needsBackgroundRefresh: false,
    };
  }
  if (effectiveManual.length > 0) {
    return {
      modelsWrite: {
        models: projectManualEntries(next, effectiveManual),
        cacheAction: { kind: 'preserve' },
      },
      needsBackgroundRefresh: true,
    };
  }
  return { needsBackgroundRefresh: true };
};

const planReplaceModelsWrite = async (
  previous: StoredUpstreamRecord,
  next: UpstreamRecord,
  nextManualModels: readonly UpstreamModelConfig[] | undefined,
): Promise<{
  readonly modelsWrite?: UpstreamModelsWritePayload;
  readonly needsBackgroundRefresh: boolean;
}> => {
  const repo = getRepo();
  const kindChanged = previous.kind !== next.kind;
  const configChanged = serializeStoredConfig(previous.config) !== serializeStoredConfig(next.config);
  const flagsChanged = serializeStoredConfig(previous.flagOverrides) !== serializeStoredConfig(next.flagOverrides);
  const transportChanged = serializeStoredConfig(previous.proxyFallbackList) !== serializeStoredConfig(next.proxyFallbackList);

  let previousManualModels: readonly UpstreamModelConfig[] = [];
  let manualModelsChanged = false;
  if (supportsManualModels(next.kind)) {
    previousManualModels = supportsManualModels(previous.kind)
      ? await repo.upstreamModels.listManualModels(previous.id)
      : [];
    if (nextManualModels !== undefined) {
      manualModelsChanged = serializeStoredConfig(previousManualModels) !== serializeStoredConfig(nextManualModels);
    }
  }
  const effectiveManual = nextManualModels ?? previousManualModels;

  const modelInputsChanged = kindChanged || configChanged || flagsChanged || manualModelsChanged;
  const hadError = previous.modelsCache.lastError !== null;
  if (!modelInputsChanged && !transportChanged) {
    if (!previous.enabled && next.enabled) {
      const requiresNetwork = upstreamRequiresNetworkForModels(next);
      if (isModelsCacheDue(previous.modelsCache, Date.now(), requiresNetwork)) {
        if (!requiresNetwork) {
          return {
            modelsWrite: {
              models: projectManualEntries(next, effectiveManual),
              cacheAction: { kind: 'set-fresh', revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() },
            },
            needsBackgroundRefresh: false,
          };
        }
        return { needsBackgroundRefresh: true };
      }
    }
    return { needsBackgroundRefresh: false };
  }

  if (!modelInputsChanged && transportChanged) {
    return {
      modelsWrite: { cacheAction: { kind: hadError ? 'mark-stale' : 'preserve' } },
      needsBackgroundRefresh: hadError || previous.modelsCache.fetchedAt === null,
    };
  }

  // Purely local catalogs (Azure, Custom with modelsFetch.enabled = false)
  // materialize synchronously inside the save transaction — zero 404 window.
  if (!upstreamRequiresNetworkForModels(next)) {
    return {
      modelsWrite: {
        models: projectManualEntries(next, effectiveManual),
        cacheAction: { kind: 'set-fresh', revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() },
      },
      needsBackgroundRefresh: false,
    };
  }

  // Hybrid upstreams (Custom with modelsFetch enabled, Ollama): when the remote
  // connection stays unchanged, overlay manual edits onto the kept auto rows
  // synchronously; removing a manual override marks stale and triggers a
  // background refresh to restore any shadowed auto model.
  if (next.kind === 'custom' || next.kind === 'ollama') {
    if (sameRemoteConnection(previous, next)) {
      const existingAuto = await repo.upstreamModels.listByUpstream(next.id, { source: 'auto' });
      const overriddenIds = new Set(effectiveManual.map(model => model.upstreamModelId));
      const upstreamFlags = resolveEffectiveFlags([flagDefaultsForKind(next.kind), next.flagOverrides]);
      const keptAuto: UpstreamModelEntry[] = existingAuto
        .filter(({ model }) => !overriddenIds.has(model.upstreamModelId))
        .map(({ model }) => ({
          source: 'auto',
          model: flagsChanged ? { ...model, enabledFlags: upstreamFlags } : model,
        }));
      const manualRemoved = previousManualModels.some(prev => !overriddenIds.has(prev.upstreamModelId));
      const clearErrorForTransport = transportChanged && hadError;
      const shouldMarkStale = manualRemoved || clearErrorForTransport;
      return {
        modelsWrite: {
          models: [...projectManualEntries(next, effectiveManual), ...keptAuto],
          cacheAction: shouldMarkStale ? { kind: 'mark-stale' } : { kind: 'preserve' },
        },
        needsBackgroundRefresh: shouldMarkStale || previous.modelsCache.fetchedAt === null,
      };
    }
    return {
      modelsWrite: {
        models: projectManualEntries(next, effectiveManual),
        cacheAction: { kind: 'clear-cache' },
      },
      needsBackgroundRefresh: true,
    };
  }

  // Remote-only providers (copilot, chatgpt, claude-code, kimi-code):
  // flag-only edits keep existing models live (SWR) while marking stale;
  // credential/host/region edits clear stale rows and trigger immediate refresh.
  if (!kindChanged && !configChanged && flagsChanged) {
    return {
      modelsWrite: { cacheAction: { kind: 'mark-stale' } },
      needsBackgroundRefresh: true,
    };
  }
  return {
    modelsWrite: {
      models: [],
      cacheAction: { kind: 'clear-cache' },
    },
    needsBackgroundRefresh: true,
  };
};

const insertUpstream = async (
  mode: 'explicit' | 'end',
  next: UpstreamRecord,
  manualModels: readonly UpstreamModelConfig[] | undefined,
  refreshContext: SaveRefreshContext,
): Promise<StoredUpstreamRecord> => {
  const upstreams = getRepo().upstreams;
  const plan = planInsertModelsWrite(next, manualModels);
  const input = {
    upstream: next,
    ...(manualModels !== undefined ? { manualModels } : {}),
    ...(plan.modelsWrite !== undefined ? { modelsWrite: plan.modelsWrite } : {}),
  };
  const saved = mode === 'end' ? await upstreams.insertAtEnd(input) : await upstreams.insert(input);
  if (saved === null) throw new HTTPException(409, { message: `Upstream ${next.id} changed concurrently` });
  if (plan.needsBackgroundRefresh) {
    scheduleUpstreamModelsRefresh(saved, refreshContext.runtimeLocation, refreshContext.scheduler);
  }
  return saved;
};

export const saveUpstream = async ({ previous, next, manualModels, refreshContext }: UpstreamChange): Promise<StoredUpstreamRecord> => {
  if (previous === null) {
    return await insertUpstream('explicit', next, manualModels, refreshContext);
  }

  const plan = await planReplaceModelsWrite(previous, next, manualModels);
  const replaceState = serializeStoredState(previous.state) !== serializeStoredState(next.state);
  const effectiveManualWrite = manualModels
    ?? (supportsManualModels(previous.kind) && !supportsManualModels(next.kind) ? [] : undefined);
  const saved = await getRepo().upstreams.replace({
    previous,
    upstream: next,
    replaceState,
    ...(effectiveManualWrite !== undefined ? { manualModels: effectiveManualWrite } : {}),
    ...(plan.modelsWrite !== undefined ? { modelsWrite: plan.modelsWrite } : {}),
  });
  if (saved === null) throw new HTTPException(409, { message: `Upstream ${next.id} changed concurrently` });
  if (plan.needsBackgroundRefresh) {
    scheduleUpstreamModelsRefresh(saved, refreshContext.runtimeLocation, refreshContext.scheduler);
  }
  return saved;
};

export const appendUpstream = async (
  next: UpstreamRecord,
  options: { readonly manualModels?: readonly UpstreamModelConfig[]; readonly refreshContext: SaveRefreshContext },
): Promise<StoredUpstreamRecord> =>
  await insertUpstream('end', next, options.manualModels, options.refreshContext);

export const saveUpstreams = async (changes: readonly UpstreamChange[]): Promise<void> => {
  for (const change of changes) await saveUpstream(change);
};
