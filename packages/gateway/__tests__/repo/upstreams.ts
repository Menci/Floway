import type { UpstreamRepo } from '../../src/repo/types.ts';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/upstream';

export const saveUpstreamForTest = async (
  repo: UpstreamRepo,
  upstream: UpstreamRecord,
  options: {
    readonly manualModels?: readonly UpstreamModelConfig[];
  } = {},
): Promise<void> => {
  const previous = await repo.getById(upstream.id);
  const optional = options.manualModels !== undefined ? { manualModels: options.manualModels } : {};
  const saved = previous === null
    ? await repo.insert({ upstream, ...optional })
    : await repo.replace({
        previous,
        upstream,
        ...optional,
        ...(options.manualModels !== undefined ? { modelsWrite: { cacheAction: { kind: 'mark-stale' } } } : {}),
      });
  if (saved === null) throw new Error(`Failed to save test upstream ${upstream.id}`);
};
