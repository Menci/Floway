import type { CustomUpstreamConfig } from './config.ts';
import { type FetchInit, type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

// https://docs.anthropic.com/en/api/versioning
const ANTHROPIC_VERSION = '2023-06-01';

// The header block is carried as field lines rather than a `Headers`, because
// a rule set may send one name several times and `Headers.append` merges a
// repeated name into one value on undici.
// https://github.com/nodejs/undici/blob/v8.3.0/lib/web/fetch/headers.js#L236-L258
const has = (lines: readonly (readonly [string, string])[], name: string): boolean =>
  lines.some(([candidate]) => candidate.toLowerCase() === name);

const replace = (lines: [string, string][], name: string, value: string): void => {
  const kept = lines.filter(([candidate]) => candidate.toLowerCase() !== name.toLowerCase());
  lines.length = 0;
  lines.push(...kept, [name, value]);
};

const customFetchInternal = async (
  config: CustomUpstreamConfig,
  path: string,
  init: FetchInit,
  options: UpstreamFetchOptions,
): Promise<Response> => {
  const headers: [string, string][] = init.headers ? [...new Headers(init.headers)] : [];
  if (config.authStyle === 'anthropic') {
    replace(headers, 'x-api-key', config.apiKey);
    if (!has(headers, 'anthropic-version')) headers.push(['anthropic-version', ANTHROPIC_VERSION]);
  } else if (config.authStyle === 'bearer') {
    replace(headers, 'Authorization', `Bearer ${config.apiKey}`);
  }
  // authStyle === 'none' falls through with no auth header. The same goes
  // for the /models fetch — Models Fetch shares this code path, so a 'none'
  // upstream is queried anonymously end-to-end.
  if (init.body && !has(headers, 'content-type') && !(init.body instanceof FormData)) {
    headers.push(['Content-Type', 'application/json']);
  }
  if (options.extraHeaders) {
    // Every line the caller supplies for a name replaces this helper's own,
    // and the caller's lines keep their order and their repetitions.
    const supplied = new Set(options.extraHeaders.map(([name]) => name.toLowerCase()));
    const kept = headers.filter(([name]) => !supplied.has(name.toLowerCase()));
    headers.length = 0;
    headers.push(...kept, ...options.extraHeaders.map(([name, value]): [string, string] => [name, value]));
  }
  return await options.wrapUpstreamCall(() => options.fetcher(joinBaseAndPath(config.baseUrl, path), { ...init, headers }));
};

// /models lives on its own fetch toggle (see config.modelsFetch.endpoint),
// not in pathOverrides.
export const customFetchModels = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, config.modelsFetch.endpoint ?? '/v1/models', init, options);
