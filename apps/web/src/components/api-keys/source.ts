import { z } from 'zod';

export type KeySource = 'generate' | 'custom';

export interface KeySourceValues {
  customKey: string;
  keySource: KeySource;
}

export type KeyWriteBody =
  | { key_source: 'generate' }
  | { key_source: 'custom'; custom_key: string };

export const keyWriteBody = (source: KeySource, customKey: string): KeyWriteBody =>
  source === 'custom'
    ? { key_source: 'custom', custom_key: customKey.trim() }
    : { key_source: 'generate' };

export const keySourceFields = {
  customKey: z.string(),
  keySource: z.enum(['generate', 'custom']),
};

export const refineKeySource = (values: KeySourceValues, ctx: z.RefinementCtx) => {
  if (values.keySource === 'custom' && !values.customKey.trim()) {
    ctx.addIssue({
      code: 'custom',
      message: 'dashboard.apiKeys.validation.customKeyRequired',
      path: ['customKey'],
    });
  }
};
