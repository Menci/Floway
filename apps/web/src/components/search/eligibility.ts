import type { ControlPlaneModel, UpstreamRecord } from '../../api/types';

// Search passthrough sends a chat completion to the upstream it names, so the
// model it picks has to be one that upstream actually serves on that endpoint.
export const servesChatFor = (model: ControlPlaneModel, upstreamId: string) =>
  model.kind === 'chat' && model.upstreams.some(binding => binding.id === upstreamId);

export const eligibleSearchUpstreams = (upstreams: readonly UpstreamRecord[], models: readonly ControlPlaneModel[]) =>
  upstreams.filter(upstream => upstream.enabled
    && (upstream.kind === 'codex' || upstream.kind === 'custom')
    && models.some(model => servesChatFor(model, upstream.id)));
