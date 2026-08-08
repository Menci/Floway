// Ollama Cloud usage action under the record-body contract. The data plane
// refreshes the same snapshot on its own behind a one-minute debounce; this is
// the operator's unconditional read, so it probes on every press.
//
// The config travels in the request body rather than being read back from the
// row: the edit form holds the plaintext API key, which lets an operator verify
// a key before saving it. A draft with no row yet is probed and reported
// without being persisted.

import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { upstreamErrorMessage as errorMessage } from './shared.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { ollamaUsageBody } from '../schemas.ts';
import type { Fetcher } from '@floway-dev/provider';
import {
  fetchOllamaUsageProbe,
  isOllamaCloudConfig,
  parseOllamaUpstreamConfig,
  refreshOllamaUsageProbe,
  type OllamaUpstreamConfig,
} from '@floway-dev/provider-ollama';

export const ollamaUsage = async (c: CtxWithJson<typeof ollamaUsageBody>) => {
  const { record } = c.req.valid('json');
  if (record.kind !== 'ollama') return c.json({ error: 'Upstream is not an Ollama upstream' }, 400);

  let config: OllamaUpstreamConfig;
  let fetcher: Fetcher;
  try {
    config = parseOllamaUpstreamConfig(record.config);
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
  if (!isOllamaCloudConfig(config)) {
    return c.json({ error: 'Usage is reported by Ollama Cloud only, for an upstream configured with an API key' }, 400);
  }

  try {
    const observation = record.id === ''
      ? await fetchOllamaUsageProbe(config, fetcher)
      : await refreshOllamaUsageProbe(record.id, config, fetcher);
    return c.json(observation);
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 502);
  }
};
