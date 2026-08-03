import type { ControlPlaneModel } from '../../src/api/types';

type ModelOverrides = Omit<Partial<ControlPlaneModel>, 'upstreams'> & {
  // The catalog carries upstream bindings as records, but a suite only ever
  // cares which upstream ids a model is bound to, so ids are what it names.
  upstreams?: readonly string[];
  contextWindow?: number;
};

const upstreamBinding = (id: string) => ({ id, name: id, kind: 'custom' as const, hue: 210 });

// One builder for the catalog shape, so a new required field on
// `ControlPlaneModel` is one edit rather than one per suite. The defaults are
// what the control plane announces for an unremarkable chat model -- no
// limits, the whole chat endpoint surface, no upstream binding -- and `kind`
// with `endpoints` are overrides like any other, which is how a suite builds
// an embedding or rerank row.
export const catalogModel = (
  id: string,
  { contextWindow, upstreams = [], ...overrides }: ModelOverrides = {},
): ControlPlaneModel => ({
  id,
  object: 'model',
  type: 'model',
  display_name: id,
  kind: 'chat',
  limits: contextWindow === undefined ? {} : { max_context_window_tokens: contextWindow },
  endpoints: { chatCompletions: {}, messages: {}, responses: {} },
  ...overrides,
  upstreams: upstreams.map(upstreamBinding),
});

// An alias row that resolves its targets in order. A suite pinning a different
// selection strategy or per-target rules writes `aliasedFrom` out on
// `catalogModel`, since those are the subject of the assertion rather than setup.
export const aliasModel = (
  id: string,
  targets: readonly string[],
  overrides: ModelOverrides = {},
): ControlPlaneModel => catalogModel(id, {
  ...overrides,
  aliasedFrom: {
    selection: 'first-available',
    targets: targets.map(target_model_id => ({ target_model_id, rules: {} })),
  },
});
