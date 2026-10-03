import type { PublicModel } from '@floway-dev/protocols/common';

type ModelOverrides = Partial<PublicModel> & { contextWindow?: number };

// One builder for the catalog shape, so a new required field on `PublicModel`
// is one edit rather than one per test. The defaults describe an unremarkable
// chat model — no limits, the whole chat endpoint surface — and `kind` with
// `endpoints` are overrides like any other, which is how a test builds an
// embedding or rerank row.
export const catalogModel = (
  id: string,
  { contextWindow, ...overrides }: ModelOverrides = {},
): PublicModel => ({
  id,
  object: 'model',
  type: 'model',
  display_name: id,
  kind: 'chat',
  limits: contextWindow === undefined ? {} : { max_context_window_tokens: contextWindow },
  endpoints: { chatCompletions: {}, messages: {}, responses: {} },
  ...overrides,
});
