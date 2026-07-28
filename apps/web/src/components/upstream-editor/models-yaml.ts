import { modelsField, type UpstreamModelConfig } from '@floway-dev/provider';
import { parse, stringify } from 'yaml';

// Bulk paste of a manual model list — migrating from another gateway's export,
// or from a script that generates one. Auto rows resolve live from the
// upstream and carry nothing to paste, so only manual models serialize.
export const serializeModels = (models: UpstreamModelConfig[]): string => stringify(models, {
  indent: 2,
  lineWidth: 0,
});

export type ParsedModels =
  | { ok: true; models: UpstreamModelConfig[] }
  | { ok: false; message: string };

export const parseModels = (text: string, { allowRerank }: { allowRerank: boolean }): ParsedModels => {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
  let models: UpstreamModelConfig[];
  try {
    models = modelsField(raw, 'dashboard');
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
  if (!allowRerank && models.some(model => model.kind === 'rerank')) {
    return { ok: false, message: 'Rerank models require a custom upstream' };
  }
  return { ok: true, models };
};
