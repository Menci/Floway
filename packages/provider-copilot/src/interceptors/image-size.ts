import { type ImageSizeCalculator, type SizeCaps, fitWithin } from '@floway-dev/platform';

// Per-model image caps for the Copilot Responses/Chat egress, measured from the
// model's server-side downscale point (the size beyond which extra pixels are
// discarded), so the calculator reproduces exactly what the upstream would do:
//
// - gpt-4o / gpt-4.1: tile encoder — samples within a 2048px box with the short
//   edge clamped to 768px.
// - gpt-5-mini: patch encoder, but likewise clamps the short edge to 768px.
// - gpt-5.4 / gpt-5.4-mini / gpt-5.5 / gpt-5.6-{sol,terra,luna} (and any
//   other model via the fallback): patch encoder capped at ~2500 32px
//   patches (~2.56 MP) within a 2048px box.
// - Gemini: no documented sampling cap; we clamp the long edge to 2048px to
//   keep tile/token cost bounded.
//
// Unknown models fall back to the gpt-5.5 budget — the most permissive cap —
// so we never over-shrink an image a model might actually use at full detail.
export const targetSizeForResponsesChat = (upstreamModelId: string): ImageSizeCalculator => {
  let caps: SizeCaps;
  if (upstreamModelId.startsWith('gemini')) caps = { maxLongEdge: 2048 };
  else if (upstreamModelId.startsWith('gpt-4o') || /^gpt-4\.1(?!-?(?:mini|nano))/.test(upstreamModelId)) caps = { maxLongEdge: 2048, maxShortEdge: 768 };
  else if (upstreamModelId.startsWith('gpt-5-mini')) caps = { maxLongEdge: 2048, maxShortEdge: 768 };
  else caps = { maxLongEdge: 2048, maxArea: 2_560_000 };
  return source => fitWithin(source, caps);
};
