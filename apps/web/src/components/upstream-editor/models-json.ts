import { modelsField, type UpstreamModelConfig } from '@floway-dev/provider';

// Bulk paste of a manual model list — migrating from another gateway's export,
// or from a script that generates one. Auto rows resolve live from the
// upstream and carry nothing to paste, so only manual models serialize.

export const serializeModels = (models: UpstreamModelConfig[]): string => JSON.stringify(models, null, 2);

export type ParsedModels =
  | { ok: true; models: UpstreamModelConfig[] }
  | { ok: false; message: string };

export const parseModels = (text: string, { allowRerank }: { allowRerank: boolean }): ParsedModels => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
  let models: UpstreamModelConfig[];
  try {
    // The same validator the gateway applies, so text that parses here is
    // text the gateway will accept.
    models = modelsField(raw, 'dashboard');
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
  if (!allowRerank && models.some(model => model.kind === 'rerank')) {
    return { ok: false, message: 'Rerank models require a custom upstream' };
  }
  return { ok: true, models };
};
