import { inferEndpointsFromModelId } from './infer-endpoints.ts';
import type { ModelEndpoints, ModelKind } from '@floway-dev/protocols/common';

export interface CustomCatalogModelDescriptor {
  id: string;
  kind?: ModelKind;
}

// A catalog row chooses its endpoint family before provider and dashboard
// projection diverge into their runtime and editor shapes. Rerank inherited
// from upstream configuration is withheld because an auto row has no
// operator-selected wire target; an explicit catalog kind remains visible to
// the dashboard as a manual-model candidate but is not routable by itself.
export const customAutoModelEndpoints = (
  model: CustomCatalogModelDescriptor,
  configured: ModelEndpoints,
): ModelEndpoints => {
  if (model.kind === 'embedding') return { embeddings: {} };
  if (model.kind === 'image') return { imagesGenerations: {}, imagesEdits: {} };
  if (model.kind === 'rerank') return { rerank: {} };
  if (model.kind === 'transcription') return { audioTranscriptions: {} };

  const endpoints = model.kind === 'chat'
    ? configured
    : inferEndpointsFromModelId(model.id) ?? configured;
  const routable = { ...endpoints };
  delete routable.rerank;
  return routable;
};
