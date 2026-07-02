// Test-only fixtures that satisfy the `@floway-dev/protocols/common` PublicModel
// shape. Production rows always carry every required field — see the gateway's
// `toPublicModel` and `toControlPlaneModel` — but tests want to fan out partials
// without retyping `object` / `type` / `display_name` / `limits` / `endpoints`
// every time. The factories merge `over` last so any field the test sets wins.

import type { ControlPlaneModel } from './types.ts';

const baseFields = (): Omit<ControlPlaneModel, 'id' | 'upstreams'> => ({
  object: 'model',
  type: 'model',
  display_name: '',
  limits: {},
  kind: 'chat',
  endpoints: { chatCompletions: {} },
});

export const buildRealModel = (over: Partial<ControlPlaneModel> & { id: string }): ControlPlaneModel => ({
  ...baseFields(),
  upstreams: [{ id: 'u1', name: 'U1', kind: 'custom' }],
  ...over,
});

export const buildAliasModel = (over: Partial<ControlPlaneModel> & { id: string }): ControlPlaneModel => ({
  ...baseFields(),
  upstreams: [],
  aliasedFrom: { selection: 'first-available', targets: [] },
  ...over,
});

export const buildUnlistedModel = (over: Partial<ControlPlaneModel> & { id: string }): ControlPlaneModel => ({
  ...baseFields(),
  upstreams: [{ id: 'u1', name: 'U1', kind: 'custom' }],
  unlisted: true,
  ...over,
});
