import type { Context } from 'hono';

import { testSearchConfigConnection } from '../../data-plane/tools/web-search/provider.ts';
import { loadSearchConfig, parseSearchConfigStrict, saveSearchConfig } from '../../data-plane/tools/web-search/search-config.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import type { searchConfigSchema } from '../schemas.ts';

export const getSearchConfigRoute = async (c: Context) => c.json(await loadSearchConfig());

export const putSearchConfigRoute = async (c: CtxWithJson<typeof searchConfigSchema>) => {
  const config = await saveSearchConfig(c.req.valid('json'));
  return c.json(config);
};

export const testSearchConfigRoute = async (c: CtxWithJson<typeof searchConfigSchema>) => {
  const result = await testSearchConfigConnection(parseSearchConfigStrict(c.req.valid('json')));
  return c.json(result, result.ok ? 200 : 400);
};
