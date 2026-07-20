import { getRepo } from '../../repo/index.ts';
import { isJsonObject } from '../../shared/json-helpers.ts';

export interface CodexUltraConfig {
  enabled: boolean;
  redirectEffort: string;
}

export const DEFAULT_CODEX_ULTRA_CONFIG: CodexUltraConfig = {
  enabled: false,
  redirectEffort: 'max',
};

export const parseCodexUltraConfigDefault = (): CodexUltraConfig => ({ ...DEFAULT_CODEX_ULTRA_CONFIG });

export const parseCodexUltraConfigStrict = (input: unknown): CodexUltraConfig => {
  if (!isJsonObject(input)) throw new Error('Codex Ultra config must be a JSON object');
  const keys = Object.keys(input);
  for (const key of keys) {
    if (key !== 'enabled' && key !== 'redirectEffort') {
      throw new Error(`Codex Ultra config has unexpected key '${key}'`);
    }
  }
  if (typeof input.enabled !== 'boolean') {
    throw new Error('Codex Ultra config enabled must be a boolean');
  }
  if (typeof input.redirectEffort !== 'string' || input.redirectEffort.length === 0) {
    throw new Error('Codex Ultra config redirectEffort must be a non-empty string');
  }
  return { enabled: input.enabled, redirectEffort: input.redirectEffort };
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
