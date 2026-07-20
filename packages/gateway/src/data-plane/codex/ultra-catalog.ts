import type { CatalogModel } from './catalog.ts';
import type { CodexUltraConfig } from './ultra-config.ts';

// Codex owns Ultra as a client orchestration mode: the catalog label promises
// maximum reasoning plus automatic delegation, while the client maps the wire
// effort to `max`. Keep this description and v2 marker aligned with the
// official catalog rather than treating `ultra` as an upstream model enum.
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/models-manager/models.json#L19-L58
const CODEX_ULTRA_DESCRIPTION = 'Maximum reasoning with automatic task delegation';

// Codex product surfaces use different User-Agent products, so Ultra only
// needs the shared case-insensitive product marker rather than a versioned
// token shape. Catalog-version resolution remains independently strict.
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/models-manager/src/manager.rs#L401-L443
export const isCodexClient = (userAgent: string | undefined): boolean =>
  userAgent?.toLowerCase().includes('codex') === true;

interface ReasoningLevel {
  effort: string;
  description: string;
}

const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === 'object'
  && value !== null
  && typeof (value as { effort?: unknown }).effort === 'string'
  && typeof (value as { description?: unknown }).description === 'string';

// The official catalog identifies this family with `gpt-*` slugs. Floway
// permits provider prefixes and OpenRouter-style variant suffixes, so family
// detection applies to the final public-id path segment before its variant.
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/models-manager/models.json#L3-L62
const isGptFamily = (slug: string): boolean => {
  const finalSegment = slug.split('/').pop();
  const baseSlug = finalSegment?.split(':', 1)[0];
  return baseSlug?.toLowerCase().startsWith('gpt-') === true;
};

export const applyCodexUltraCatalogSupport = (
  model: CatalogModel,
  config: CodexUltraConfig,
): CatalogModel => {
  if (!config.enabled) return model;

  const existing = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels.filter(isReasoningLevel)
    : [];
  if (!isGptFamily(model.slug) || !existing.some(level => level.effort === 'max')) return model;

  const supportedReasoningLevels = existing.some(level => level.effort === 'ultra')
    ? existing
    : [...existing, { effort: 'ultra', description: CODEX_ULTRA_DESCRIPTION }];

  return {
    ...model,
    supported_reasoning_levels: supportedReasoningLevels,
    multi_agent_version: 'v2',
  };
};
