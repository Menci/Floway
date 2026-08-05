import type { Context } from 'hono';

import { inboundHeaderAllowlistForKind } from '../providers/registry.ts';
import type { InboundHeaderMatcher, IngressHeaderRule, Provider } from '@floway-dev/provider';

export const inboundHeaders = (c: Context): Headers => new Headers(c.req.raw.headers);

const regexpMatches = (regexp: RegExp, value: string): boolean =>
  new RegExp(regexp.source, regexp.flags).test(value);

const matcherMatches = (matcher: InboundHeaderMatcher, name: string): boolean =>
  typeof matcher === 'string' ? matcher.toLowerCase() === name : regexpMatches(matcher, name);

export const resolveIngressHeaders = (
  headers: Headers,
  allowlist: readonly InboundHeaderMatcher[],
  rules: readonly IngressHeaderRule[],
): Headers => {
  const filtered = new Headers();
  for (const [name, value] of headers) {
    const normalizedName = name.toLowerCase();
    const rule = rules.find(candidate => matcherMatches(candidate.matcher, normalizedName));
    if (rule !== undefined) filtered.append(name, rule.value ?? value);
    else if (allowlist.some(matcher => matcherMatches(matcher, normalizedName))) filtered.append(name, value);
  }
  return filtered;
};

export const resolveIngressHeadersForProvider = (
  headers: Headers,
  provider: Provider,
): Headers => resolveIngressHeaders(headers, inboundHeaderAllowlistForKind(provider.kind), provider.ingressHeaderRules);
