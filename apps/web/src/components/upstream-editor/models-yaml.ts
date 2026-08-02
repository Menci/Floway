import { parse, stringify } from 'yaml';

import { errorMessage } from '../../lib/error-message';
import { modelsField, type UpstreamModelConfig } from '@floway-dev/provider';

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
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
  let models: UpstreamModelConfig[];
  try {
    models = modelsField(raw, 'dashboard');
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
  if (!allowRerank && models.some(model => model.kind === 'rerank')) {
    return { ok: false, message: 'Rerank models require a custom upstream' };
  }
  return { ok: true, models };
};
