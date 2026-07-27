import type { Context } from 'hono';

import { loadWebSearchConfig, parseWebSearchConfigStrict, saveWebSearchConfig } from '../../data-plane/tools/web-search/config.ts';
import { testWebSearchConfigConnection } from '../../data-plane/tools/web-search/provider.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import type { webSearchConfigSchema } from '../schemas.ts';

export const getWebSearchConfigRoute = async (c: Context) => c.json(await loadWebSearchConfig());

export const putWebSearchConfigRoute = async (c: CtxWithJson<typeof webSearchConfigSchema>) => {
  const config = await saveWebSearchConfig(c.req.valid('json'));
  return c.json(config);
};

export const testWebSearchConfigRoute = async (c: CtxWithJson<typeof webSearchConfigSchema>) => {
  const result = await testWebSearchConfigConnection(parseWebSearchConfigStrict(c.req.valid('json')));
  return c.json(result, result.ok ? 200 : 400);
};
