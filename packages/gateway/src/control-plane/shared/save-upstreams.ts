import { HTTPException } from 'hono/http-exception';

import { flagDefaultsForKind } from '../../data-plane/providers/registry.ts';
import { scheduleUpstreamModelsRefresh, supportsManualModels, upstreamRequiresNetworkForModels } from '../../execution/models-refresh.ts';
import { getRepo } from '../../repo/index.ts';
import { MODEL_CATALOG_REVISION } from '../../repo/models-cache-contract.ts';
import type { StoredUpstreamRecord, UpstreamModelEntry, UpstreamModelsWritePayload } from '../../repo/types.ts';
import { serializeStoredConfig, serializeStoredState } from '../../repo/upstream-json.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { resolveEffectiveFlags, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/provider';
import { projectAzureModels } from '@floway-dev/provider-azure';
import { assertCustomUpstreamRecord, projectCustomManualModels, projectCustomModelsFromDiscovered } from '@floway-dev/provider-custom';
import { assertOllamaUpstreamRecord, projectOllamaManualModels } from '@floway-dev/provider-ollama';

export interface SaveRefreshContext {
  readonly runtimeLocation: string | null;
  readonly scheduler: BackgroundScheduler;
}

export interface UpstreamChange {
  readonly previous: StoredUpstreamRecord | null;
  readonly next: UpstreamRecord;
  readonly manualModels?: readonly UpstreamModelConfig[];
  readonly refreshContext?: SaveRefreshContext;
}

const sameCustomRemoteConnection = (previous: UpstreamRecord, next: UpstreamRecord): boolean => {
  if (previous.kind !== 'custom' || next.kind !== 'custom') return false;
  const prevCfg = assertCustomUpstreamRecord(previous).config;
  const nextCfg = assertCustomUpstreamRecord(next).config;
  return prevCfg.baseUrl === nextCfg.baseUrl
    && prevCfg.apiKey === nextCfg.apiKey
    && serializeStoredConfig(prevCfg.modelsFetch) === serializeStoredConfig(nextCfg.modelsFetch);
};

const sameOllamaRemoteConnection = (previous: UpstreamRecord, next: UpstreamRecord): boolean => {
  if (previous.kind !== 'ollama' || next.kind !== 'ollama') return false;
  const prevCfg = assertOllamaUpstreamRecord(previous).config;
  const nextCfg = assertOllamaUpstreamRecord(next).config;
  return prevCfg.baseUrl === nextCfg.baseUrl
    && prevCfg.apiKey === nextCfg.apiKey;
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
  const effectiveManual = supportsManualModels(next.kind) ? (manualModels ?? []) : [];
  if (!upstreamRequiresNetworkForModels(next)) {
    return {
      modelsWrite: {
        models: projectManualEntries(next, effectiveManual),
        ...(next.kind === 'custom' ? { discovered: null } : {}),
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
  readonly bumpConfigVersion: boolean;
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
  const bumpConfigVersion = modelInputsChanged || transportChanged;

  if (!bumpConfigVersion) {
    return { bumpConfigVersion: false, needsBackgroundRefresh: false };
  }

  if (!modelInputsChanged && transportChanged) {
    return {
      bumpConfigVersion: true,
      modelsWrite: { cacheAction: { kind: 'clear-error' } },
      needsBackgroundRefresh: previous.modelsCache.lastError !== null,
    };
  }

  // Purely local catalogs (Azure, Custom with modelsFetch.enabled = false)
  // materialize synchronously inside the save transaction — zero 404 window.
  if (!upstreamRequiresNetworkForModels(next)) {
    return {
      bumpConfigVersion: true,
      modelsWrite: {
        models: projectManualEntries(next, effectiveManual),
        ...(next.kind === 'custom' ? { discovered: null } : {}),
        cacheAction: { kind: 'set-fresh', revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() },
      },
      needsBackgroundRefresh: false,
    };
  }

  if (next.kind === 'custom') {
    if (!kindChanged && sameCustomRemoteConnection(previous, next)) {
      const discovered = await repo.upstreamModels.getCustomDiscovered(next.id);
      if (discovered !== null) {
        const projected = projectCustomModelsFromDiscovered(next, effectiveManual, discovered);
        return {
          bumpConfigVersion: true,
          modelsWrite: {
            models: [
              ...projected.manual.map(model => ({ source: 'manual' as const, model })),
              ...projected.auto.map(model => ({ source: 'auto' as const, model })),
            ],
            cacheAction: { kind: 'preserve' },
          },
          needsBackgroundRefresh: false,
        };
      }
      return {
        bumpConfigVersion: true,
        modelsWrite: {
          models: projectManualEntries(next, effectiveManual),
          cacheAction: { kind: 'clear-cache' },
        },
        needsBackgroundRefresh: true,
      };
    }
    return {
      bumpConfigVersion: true,
      modelsWrite: {
        models: projectManualEntries(next, effectiveManual),
        discovered: null,
        cacheAction: { kind: 'clear-cache' },
      },
      needsBackgroundRefresh: true,
    };
  }

  if (next.kind === 'ollama') {
    if (!kindChanged && sameOllamaRemoteConnection(previous, next)) {
      const existingAuto = await repo.upstreamModels.listByUpstream(next.id, { source: 'auto' });
      const overriddenIds = new Set(effectiveManual.map(model => model.upstreamModelId));
      const upstreamFlags = resolveEffectiveFlags([flagDefaultsForKind('ollama'), next.flagOverrides]);
      const keptAuto: UpstreamModelEntry[] = existingAuto
        .filter(({ model }) => !overriddenIds.has(model.upstreamModelId))
        .map(({ model }) => ({
          source: 'auto',
          model: flagsChanged ? { ...model, enabledFlags: upstreamFlags } : model,
        }));
      const manualRemoved = previousManualModels.some(prev => !overriddenIds.has(prev.upstreamModelId));
      return {
        bumpConfigVersion: true,
        modelsWrite: {
          models: [...projectManualEntries(next, effectiveManual), ...keptAuto],
          cacheAction: manualRemoved ? { kind: 'mark-stale' } : { kind: 'preserve' },
        },
        needsBackgroundRefresh: manualRemoved || previous.modelsCache.fetchedAt === null,
      };
    }
    return {
      bumpConfigVersion: true,
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
      bumpConfigVersion: true,
      modelsWrite: { cacheAction: { kind: 'mark-stale' } },
      needsBackgroundRefresh: true,
    };
  }
  return {
    bumpConfigVersion: true,
    modelsWrite: {
      models: [],
      cacheAction: { kind: 'clear-cache' },
    },
    needsBackgroundRefresh: true,
  };
};

export const saveUpstream = async ({ previous, next, manualModels, refreshContext }: UpstreamChange): Promise<StoredUpstreamRecord> => {
  const upstreams = getRepo().upstreams;
  if (previous === null) {
    const plan = planInsertModelsWrite(next, manualModels);
    const saved = await upstreams.insert({
      upstream: next,
      ...(supportsManualModels(next.kind) ? { manualModels: manualModels ?? [] } : {}),
      ...(plan.modelsWrite !== undefined ? { modelsWrite: plan.modelsWrite } : {}),
    });
    if (saved === null) throw new HTTPException(409, { message: `Upstream ${next.id} changed concurrently` });
    if (plan.needsBackgroundRefresh && refreshContext !== undefined) {
      scheduleUpstreamModelsRefresh(saved, refreshContext.runtimeLocation, refreshContext.scheduler);
    }
    return saved;
  }

  const plan = await planReplaceModelsWrite(previous, next, manualModels);
  const replaceState = serializeStoredState(previous.state) !== serializeStoredState(next.state);
  const saved = await upstreams.replace({
    previous,
    upstream: next,
    bumpConfigVersion: plan.bumpConfigVersion,
    replaceState,
    ...(manualModels !== undefined ? { manualModels } : {}),
    ...(plan.modelsWrite !== undefined ? { modelsWrite: plan.modelsWrite } : {}),
  });
  if (saved === null) throw new HTTPException(409, { message: `Upstream ${next.id} changed concurrently` });
  if (plan.needsBackgroundRefresh && refreshContext !== undefined) {
    scheduleUpstreamModelsRefresh(saved, refreshContext.runtimeLocation, refreshContext.scheduler);
  }
  return saved;
};

export const appendUpstream = async (
  next: UpstreamRecord,
  options?: { readonly manualModels?: readonly UpstreamModelConfig[]; readonly refreshContext?: SaveRefreshContext },
): Promise<StoredUpstreamRecord> => {
  const plan = planInsertModelsWrite(next, options?.manualModels);
  const saved = await getRepo().upstreams.insertAtEnd({
    upstream: next,
    ...(supportsManualModels(next.kind) ? { manualModels: options?.manualModels ?? [] } : {}),
    ...(plan.modelsWrite !== undefined ? { modelsWrite: plan.modelsWrite } : {}),
  });
  if (saved === null) throw new HTTPException(409, { message: `Upstream ${next.id} changed concurrently` });
  if (plan.needsBackgroundRefresh && options?.refreshContext !== undefined) {
    scheduleUpstreamModelsRefresh(saved, options.refreshContext.runtimeLocation, options.refreshContext.scheduler);
  }
  return saved;
};

export const saveUpstreams = async (changes: readonly UpstreamChange[]): Promise<void> => {
  for (const change of changes) await saveUpstream(change);
};
