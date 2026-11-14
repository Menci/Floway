import type { Repo } from './types.ts';
import { createUpstreamMetricsRecorder } from '../upstream-metrics/recorder.ts';
import { initProviderRepo } from '@floway-dev/provider';

let _repo: Repo | null = null;

export function initRepo(repo: Repo): void {
  _repo = repo;
  // Hand provider-package helpers (models-store, etc.) a lazy accessor for the
  // same singleton so they read the cache through the live repo.
  const recordUpstreamMetric = createUpstreamMetricsRecorder(repo);
  initProviderRepo(() => ({ upstreams: getRepo().upstreams, recordUpstreamMetric }));
}

export function getRepo(): Repo {
  if (!_repo) throw new Error('Repo not initialized — call initRepo() first');
  return _repo;
}
