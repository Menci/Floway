import { getRepo } from '../../repo/index.ts';
import { isJsonObject } from '../../shared/json-helpers.ts';

export interface CodexUltraConfig {
  enabled: boolean;
}

// Codex maps its client-only Ultra selection to `max` on Responses requests.
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/core/src/client.rs#L175-L180
export const DEFAULT_CODEX_ULTRA_CONFIG: CodexUltraConfig = {
  enabled: false,
};

export const parseCodexUltraConfigDefault = (): CodexUltraConfig => ({ ...DEFAULT_CODEX_ULTRA_CONFIG });

export const parseCodexUltraConfigStrict = (input: unknown): CodexUltraConfig => {
  if (!isJsonObject(input)) throw new Error('Codex Ultra config must be a JSON object');
  const keys = Object.keys(input);
  for (const key of keys) {
    if (key !== 'enabled') {
      throw new Error(`Codex Ultra config has unexpected key '${key}'`);
    }
  }
  if (typeof input.enabled !== 'boolean') {
    throw new Error('Codex Ultra config enabled must be a boolean');
  }
  return { enabled: input.enabled };
};

export const loadCodexUltraConfig = async (): Promise<CodexUltraConfig> => {
  const stored = await getRepo().codexUltraConfig.get();
  return stored === null ? parseCodexUltraConfigDefault() : parseCodexUltraConfigStrict(stored);
};

export const saveCodexUltraConfig = async (input: unknown): Promise<CodexUltraConfig> => {
  const parsed = parseCodexUltraConfigStrict(input);
  await getRepo().codexUltraConfig.save(parsed);
  return parsed;
};
