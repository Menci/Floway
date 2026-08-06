import { parse, stringify } from 'yaml';

import { errorMessage } from '../../lib/error-message';
import { endpointsSupportKind } from '@floway-dev/protocols/common';
import { modelsField, type UpstreamModelConfig } from '@floway-dev/provider';
import type { UpstreamProviderKind } from '@floway-dev/provider/model';

export const serializeModels = (models: UpstreamModelConfig[]): string => stringify(models, {
  indent: 2,
  lineWidth: 0,
});

export type ParsedModels =
  | { ok: true; models: UpstreamModelConfig[] }
  | { ok: false; message: string };

export const parseModels = (text: string, { providerKind }: { providerKind: UpstreamProviderKind }): ParsedModels => {
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
  if (providerKind !== 'custom' && models.some(model => endpointsSupportKind(model.endpoints, 'rerank'))) {
    return { ok: false, message: 'Rerank models require a custom upstream' };
  }
  if (providerKind === 'ollama' && models.some(model => endpointsSupportKind(model.endpoints, 'image'))) {
    return { ok: false, message: 'Image models require a custom or Azure upstream' };
  }
  return { ok: true, models };
};
