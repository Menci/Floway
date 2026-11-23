import type { CustomAuthStyle, CustomIngressHeaderRule } from './config.ts';
import { customAuthHeaders } from './fetch.ts';
import type { CustomUpstreamConfigFacts } from './upstream.ts';
import { secret } from '@floway-dev/pipeline';
import { setAnthropicBetaHeader, type HeaderEntry } from '@floway-dev/provider';

const passthroughValue = (headers: readonly HeaderEntry[], key: string): HeaderEntry[1] | undefined => {
  const values = headers.flatMap(([name, value]) => name.toLowerCase() === key ? [value] : []);
  if (values.length < 2) return values[0];
  const joined = values.map(value => typeof value === 'string' ? value : value.reveal()).join(', ');
  return values.some(value => typeof value !== 'string') ? secret(joined) : joined;
};

const resolveIngressHeaders = (incoming: readonly HeaderEntry[], rules: readonly Readonly<CustomIngressHeaderRule>[]): readonly HeaderEntry[] => {
  const valuesByKey = new Map<string, (string | null)[]>();
  for (const { key, value } of rules) {
    const values = valuesByKey.get(key);
    if (values === undefined) valuesByKey.set(key, [value]);
    else values.push(value);
  }

  const resolved: HeaderEntry[] = [];
  for (const [key, values] of valuesByKey) {
    for (const value of values) {
      const admitted = value ?? passthroughValue(incoming, key);
      if (admitted !== undefined) resolved.push([key, admitted]);
    }
  }
  return resolved;
};

export const customRequestHeaders = (
  config: CustomUpstreamConfigFacts,
  auth: CustomAuthStyle,
  anthropicBeta?: readonly string[],
) => (incoming: readonly HeaderEntry[]): readonly HeaderEntry[] => {
  const resolved = resolveIngressHeaders(incoming, config.ingressHeadersRules);
  const supplied = new Set(resolved.map(([name]) => name));
  const defaults = customAuthHeaders(config.apiKey.reveal(), auth)
    .filter(([name]) => !supplied.has(name.toLowerCase()))
    .map(([name, value]): HeaderEntry => [name, name === 'x-goog-api-key' ? config.apiKey : value]);
  const headers = [...defaults, ...resolved];
  return anthropicBeta === undefined ? headers : setAnthropicBetaHeader(headers, anthropicBeta);
};
