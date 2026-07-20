import type { CatalogModel } from './catalog.ts';
import type { CodexUltraConfig } from './ultra-config.ts';

// Codex owns Ultra as a client orchestration mode: the catalog label promises
// maximum reasoning plus automatic delegation, while the client maps the wire
// effort to `max`. Keep this description and v2 marker aligned with the
// official catalog rather than treating `ultra` as an upstream model enum.
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/models-manager/models.json#L19-L58
const CODEX_ULTRA_DESCRIPTION = 'Maximum reasoning with automatic task delegation';

interface ReasoningLevel {
  effort: string;
  description: string;
}

const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === 'object'
  && value !== null
  && typeof (value as { effort?: unknown }).effort === 'string'
  && typeof (value as { description?: unknown }).description === 'string';

export const applyCodexUltraCatalogSupport = (
  model: CatalogModel,
  config: CodexUltraConfig,
): CatalogModel => {
  if (!config.enabled) return model;

  const existing = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels.filter(isReasoningLevel)
    : [];
  const supportedReasoningLevels = existing.some(level => level.effort === 'ultra')
    ? existing
    : [...existing, { effort: 'ultra', description: CODEX_ULTRA_DESCRIPTION }];

  return {
    ...model,
    supported_reasoning_levels: supportedReasoningLevels,
    multi_agent_version: 'v2',
  };
};
