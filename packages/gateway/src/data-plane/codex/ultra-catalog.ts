import type { CatalogModel } from './catalog.ts';
import { parseCodexVersion } from './catalog.ts';
import type { CodexUltraConfig } from './ultra-config.ts';

// Codex owns Ultra as a client orchestration mode: the catalog label promises
// maximum reasoning plus automatic delegation, while the client maps the wire
// effort to `max`. Keep this description and v2 marker aligned with the
// official catalog rather than treating `ultra` as an upstream model enum.
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/models-manager/models.json#L19-L58
const CODEX_ULTRA_DESCRIPTION = 'Maximum reasoning with automatic task delegation';

// Ultra first appeared in the official catalog at this minimum client
// version. Older clients parse it as an unknown open-string effort, send
// `ultra` upstream verbatim, and do not activate Proactive mode.
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/models-manager/models.json#L19-L62
const CODEX_ULTRA_MIN_CLIENT_VERSION = [0, 144, 0] as const;

interface ReasoningLevel {
  effort: string;
  description: string;
}

const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === 'object'
  && value !== null
  && typeof (value as { effort?: unknown }).effort === 'string'
  && typeof (value as { description?: unknown }).description === 'string';

export const codexClientSupportsUltra = (userAgent: string | undefined): boolean => {
  const version = parseCodexVersion(userAgent);
  if (version === null) return false;
  const core = version.split('-', 1)[0]!.split('.').map(Number);
  for (let index = 0; index < CODEX_ULTRA_MIN_CLIENT_VERSION.length; index++) {
    const difference = (core[index] ?? 0) - CODEX_ULTRA_MIN_CLIENT_VERSION[index];
    if (difference !== 0) return difference > 0;
  }
  return true;
};

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
