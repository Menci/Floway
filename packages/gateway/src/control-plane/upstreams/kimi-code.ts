import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { upstreamErrorMessage } from './shared.ts';
import { fullUpstreamActionError } from '../../access-control/upstream-edit.ts';
import { userFromContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { kimiCodeUsageBody } from '../schemas.ts';
import type { Fetcher } from '@floway-dev/upstream';
import { parseKimiCodeUpstreamConfig, refreshKimiCodeAccountProbe, refreshKimiCodeUsageProbe, type KimiCodeUpstreamConfig } from '@floway-dev/upstream-kimi-code';

export const kimiCodeUsage = async (c: CtxWithJson<typeof kimiCodeUsageBody>) => {
  const { record } = c.req.valid('json');
  const accessError = await fullUpstreamActionError(userFromContext(c), record.id);
  if (accessError) return c.json({ error: accessError.error }, accessError.status);
  if (record.kind !== 'kimi-code') return c.json({ error: 'Upstream is not a Kimi Code upstream' }, 400);
  let config: KimiCodeUpstreamConfig;
  let fetcher: Fetcher;
  try {
    config = parseKimiCodeUpstreamConfig(record.config);
    fetcher = await resolveControlPlaneFetcher({ override: record.proxy_fallback_list, upstreamId: record.id || undefined, runtimeLocation: getRuntimeLocation(c.req.raw) });
  } catch (error) {
    return c.json({ error: upstreamErrorMessage(error) }, 400);
  }
  const [usage, account] = await Promise.allSettled([
    refreshKimiCodeUsageProbe(record.id, config, fetcher),
    refreshKimiCodeAccountProbe(record.id, config, fetcher),
  ]);
  if (usage.status === 'rejected') return c.json({ error: upstreamErrorMessage(usage.reason) }, 502);
  return c.json({
    observation: usage.value,
    account: account.status === 'fulfilled' ? account.value : null,
    accountError: account.status === 'rejected' ? upstreamErrorMessage(account.reason).replaceAll(config.apiKey, '[redacted]') : null,
  });
};
