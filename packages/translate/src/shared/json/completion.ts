import { parseJSONObject } from './object.ts';

export const parseJSONObjectUnlessTruncated = (
  text: string,
  completion: 'complete' | 'truncated',
  parser?: (text: string) => unknown,
): { readonly completion: 'truncated' } | { readonly completion: 'complete'; readonly value: ReturnType<typeof parseJSONObject> } =>
  completion === 'truncated' ? { completion } : { completion, value: parseJSONObject(text, parser) };
